/**
 * Phase 20B, the finance mailbox webhook end to end over an in-memory database and storage (tests/helpers/fake-admin.ts):
 * the route answers 404 for an unknown or switched-off account, 401 for a wrong password, 413 over the cap; an allowed
 * sender's attachments become ready, unlabelled inbox documents (sender DOMAIN only; no body, subject, name or file name
 * anywhere); a replay of the same MessageID stores nothing twice; other senders are dropped and counted; a training
 * workspace stores nothing; an infected file is never kept; a storage failure answers 500 so the provider retries.
 * Synthetic messages only; nothing reaches a provider.
 */
import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdmin, type FakeAdmin } from "../../helpers/fake-admin";

import {
  postmarkMessage,
  receivedSpf,
  SAMPLE,
  spamTests,
  type PostmarkAttachment,
} from "./mailbox-fixtures";

const state = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { encryptJson } = await import("@/lib/crypto");
const { POST } = await import("@/app/api/webhooks/integrations/finance_mailbox/[accountId]/route");
const { mailboxWebhookSpec } = await import("@/lib/finance/mailbox-server");
const { receiveIntegrationWebhook } = await import("@/lib/integrations/webhook-route");

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000b1";
const SECRET = "synthetic_mailbox_password_0123456789";
const auth = (pw = SECRET) => `Basic ${Buffer.from(`pulse:${pw}`).toString("base64")}`;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

type Stored = { path: string; bytes: Uint8Array; contentType: string };
let objects: Map<string, Stored>;
let failUploads = false;
let admin: FakeAdmin;

function setup(o: { enabled?: boolean; training?: boolean; allowed?: string } = {}) {
  objects = new Map();
  failUploads = false;
  admin = createFakeAdmin(
    {
      orgs: [{ id: ORG, is_training: o.training ?? false }],
      integration_accounts: [
        {
          id: ACCOUNT,
          org_id: ORG,
          kind: "finance_mailbox",
          enabled: o.enabled ?? true,
          config: {
            provider: "postmark",
            allowed_senders: o.allowed ?? "accounts@supplier-one.example supplier-two.example",
          },
          config_enc: encryptJson({ webhook_secret: SECRET }),
        },
      ],
    },
    {
      unique: {
        integration_webhook_events: [["org_id", "provider", "event_key"]],
        fin_documents: [["org_id", "sha256"]],
      },
      defaults: {
        fin_documents: () => ({
          status: "pending",
          scan_status: "unscanned",
          routed_at: null,
          sha256: null,
        }),
      },
      rpc: {
        rate_limit_hit: () => [{ allowed: true, hits: 1, retry_after: 0 }],
        integration_usage_bump: () => null,
      },
    },
  );
  (admin as unknown as { storage: unknown }).storage = {
    from: () => ({
      upload: async (path: string, bytes: Uint8Array, opts: { contentType: string }) => {
        if (failUploads) return { data: null, error: { message: "storage down" } };
        objects.set(path, { path, bytes, contentType: opts.contentType });
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        for (const p of paths) objects.delete(p);
        return { data: [], error: null };
      },
      createSignedUrl: async () => ({ data: null, error: { message: "not in tests" } }),
    }),
  };
  state.admin = admin;
}

const docs = () => admin._rows("fin_documents");
const usage = () => {
  const out: Record<string, number> = {};
  for (const c of admin._calls.filter((x) => x.table === "rpc:integration_usage_bump")) {
    const p = c.payload as { p_metric: string; p_n: number; p_provider: string };
    expect(p.p_provider).toBe("finance_mailbox");
    out[p.p_metric] = (out[p.p_metric] ?? 0) + p.p_n;
  }
  return out;
};

async function post(
  body: string,
  o: {
    authorization?: string | null;
    account?: string;
    spec?: ReturnType<typeof mailboxWebhookSpec>;
  } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.authorization !== null) headers.authorization = o.authorization ?? auth();
  const account = o.account ?? ACCOUNT;
  const req = new Request(
    `https://pulse.example/api/webhooks/integrations/finance_mailbox/${account}`,
    {
      method: "POST",
      body,
      headers,
    },
  );
  return o.spec
    ? receiveIntegrationWebhook(req, account, "finance_mailbox", o.spec, { admin: admin as never })
    : POST(req, { params: Promise.resolve({ accountId: account }) });
}

const pdf: PostmarkAttachment = {
  Name: "Invoice 0042 Synthetic.pdf",
  Content: b64(SAMPLE.pdf),
  ContentType: "application/pdf",
};

beforeEach(() => setup());

describe("finance mailbox webhook: who may post", () => {
  it("answers 404 for an unknown account, a malformed id and a switched-off account, and stores nothing", async () => {
    expect(
      (
        await post(postmarkMessage({ attachments: [pdf] }), {
          account: "00000000-0000-4000-8000-0000000000ff",
        })
      ).status,
    ).toBe(404);
    expect(
      (await post(postmarkMessage({ attachments: [pdf] }), { account: "not-a-uuid" })).status,
    ).toBe(404);
    setup({ enabled: false });
    expect((await post(postmarkMessage({ attachments: [pdf] }))).status).toBe(404);
    expect(docs()).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it("answers 401 without the password, with a wrong one or the wrong user, and stores nothing", async () => {
    const body = postmarkMessage({ attachments: [pdf] });
    expect((await post(body, { authorization: null })).status).toBe(401);
    expect((await post(body, { authorization: auth("wrong_password_0123456789xyz") })).status).toBe(
      401,
    );
    expect(
      (
        await post(body, {
          authorization: `Basic ${Buffer.from(`admin:${SECRET}`).toString("base64")}`,
        })
      ).status,
    ).toBe(401);
    expect(docs()).toEqual([]);
    expect(admin._rows("integration_webhook_events")).toEqual([]);
  });

  it("answers 413 over the cap before reading or storing anything", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    expect((await post(big)).status).toBe(413);
    expect(docs()).toEqual([]);
  });

  it("answers 400 for a body that is not an inbound message", async () => {
    expect((await post("{}")).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
  });
});

describe("finance mailbox webhook: what is kept", () => {
  it("stores an allowed sender's attachments as ready, unlabelled inbox documents with the sender's domain only", async () => {
    const res = await post(
      postmarkMessage({
        attachments: [
          pdf,
          { Name: "Scan 0007.jpg", Content: b64(SAMPLE.jpeg), ContentType: "image/jpeg" },
          { Name: "October statement.csv", Content: b64(SAMPLE.csv), ContentType: "text/csv" },
          {
            Name: "Workbook.xlsx",
            Content: b64(SAMPLE.xlsx),
            ContentType: "application/octet-stream",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 1, duplicates: 0 });
    const rows = docs();
    expect(rows.map((d) => d.mime_type).sort()).toEqual([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/jpeg",
      "text/csv",
    ]);
    for (const d of rows) {
      expect(d).toMatchObject({
        org_id: ORG,
        kind: "unclassified",
        source: "email",
        status: "ready",
        sender_domain: "supplier-one.example",
        scan_status: "unscanned",
      });
      expect(d.inbox_at).toBeTruthy();
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(String(d.storage_path)).toMatch(new RegExp(`^${ORG}/${d.id}\\.(pdf|jpg|csv|xlsx)$`));
      const stored = objects.get(String(d.storage_path))!;
      expect(stored.contentType).toBe(d.mime_type);
    }
    expect(
      Buffer.from(
        objects.get(String(rows.find((d) => d.mime_type === "application/pdf")!.storage_path))!
          .bytes,
      ).equals(Buffer.from(SAMPLE.pdf)),
    ).toBe(true);
    expect(usage()).toEqual({ messages: 1, stored: 4 });
  });

  it("never keeps the body, subject, sender address or name, file names or headers anywhere", async () => {
    await post(postmarkMessage({ attachments: [pdf] }));
    const everything = JSON.stringify({
      docs: docs(),
      events: admin._rows("integration_webhook_events"),
      calls: admin._calls.map((c) => c.payload ?? null),
      paths: [...objects.keys()],
    });
    for (const secret of [
      "Synthetic Subject 7",
      "Synthetic body text",
      "Synthetic html",
      "Sam Sender",
      "accounts@supplier-one.example",
      "Invoice 0042",
      "X-Synthetic-Header",
      "clinic.example",
    ])
      expect(everything, secret).not.toContain(secret);
  });

  it("a replay of the same MessageID stores nothing twice; the same file in another message is a duplicate", async () => {
    const body = postmarkMessage({ attachments: [pdf] });
    expect((await (await post(body)).json()).processed).toBe(1);
    expect(await (await post(body)).json()).toEqual({ ok: true, processed: 0, duplicates: 1 });
    expect(docs()).toHaveLength(1);
    const again = await post(
      postmarkMessage({ id: "00000000-0000-4000-8000-0000000000m2", attachments: [pdf, pdf] }),
    );
    expect(again.status).toBe(200);
    expect(docs()).toHaveLength(1);
    expect(objects.size).toBe(1);
    expect(usage()).toMatchObject({ messages: 2, stored: 1, duplicate: 2 });
  });

  it("drops a sender who is not allowed (acknowledged, counted, nothing stored); a whole allowed domain works", async () => {
    const res = await post(
      postmarkMessage({ from: "billing@unknown-vendor.example", attachments: [pdf] }),
    );
    expect(res.status).toBe(200);
    expect(docs()).toEqual([]);
    expect(admin._rows("integration_webhook_events")[0]).toMatchObject({
      outcome: "dropped_sender",
    });
    expect(usage()).toEqual({ dropped_sender: 1 });
    await post(
      postmarkMessage({ id: "m-domain", from: "anyone@supplier-two.example", attachments: [pdf] }),
    );
    expect(docs()).toHaveLength(1);
    expect(docs()[0].sender_domain).toBe("supplier-two.example");
  });

  it("drops an allowed address that fails SPF and DKIM for its domain (a forged From), counted like an unknown sender", async () => {
    const forged = await post(
      postmarkMessage({
        id: "m-forged",
        attachments: [pdf],
        headers: [
          receivedSpf("Fail", "x@attacker.example"),
          spamTests("SPF_FAIL,DKIM_SIGNED,DKIM_VALID"),
        ],
      }),
    );
    expect(forged.status).toBe(200);
    await post(postmarkMessage({ id: "m-noauth", attachments: [pdf], headers: [] }));
    expect(docs()).toEqual([]);
    expect(admin._rows("integration_webhook_events").map((e) => e.outcome)).toEqual([
      "dropped_sender",
      "dropped_sender",
    ]);
    expect(usage()).toEqual({ dropped_sender: 2 });
    // DKIM of the From domain alone is enough
    await post(
      postmarkMessage({
        id: "m-dkim",
        attachments: [pdf],
        headers: [
          receivedSpf("SoftFail", "x@bulk-sender.example"),
          spamTests("DKIM_VALID,DKIM_VALID_AU"),
        ],
      }),
    );
    expect(docs()).toHaveLength(1);
  });

  it("refuses types it does not take whatever they claim, oversized and empty files, and skips signature pictures", async () => {
    await post(
      postmarkMessage({
        attachments: [
          { Name: "invoice.pdf", Content: b64(SAMPLE.exe), ContentType: "application/pdf" },
          { Name: "letter.docx", Content: b64(SAMPLE.docx), ContentType: "application/pdf" },
          { Name: "notes.txt", Content: b64(SAMPLE.csv), ContentType: "text/plain" },
          { Name: "empty.pdf", Content: "", ContentType: "application/pdf" },
          {
            Name: "logo.png",
            Content: b64(SAMPLE.png),
            ContentType: "image/png",
            ContentID: "logo@synthetic",
          },
        ],
      }),
    );
    expect(docs()).toEqual([]);
    expect(objects.size).toBe(0);
    expect(usage()).toEqual({ messages: 1, refused_type: 3, refused_size: 1, skipped_inline: 1 });
  });

  it("stores nothing for a training workspace", async () => {
    setup({ training: true });
    expect((await post(postmarkMessage({ attachments: [pdf] }))).status).toBe(200);
    expect(docs()).toEqual([]);
    expect(usage()).toEqual({ refused_training: 1 });
  });

  it("never keeps a file the malware scan blocks", async () => {
    const infected = {
      name: "fake",
      scan: async () => ({ verdict: "infected" as const, engine: "fake" }),
    };
    const res = await post(postmarkMessage({ attachments: [pdf] }), {
      spec: mailboxWebhookSpec(infected),
    });
    expect(res.status).toBe(200);
    expect(docs()).toEqual([]);
    expect(objects.size).toBe(0);
    expect(usage()).toMatchObject({ infected: 1 });
  });

  it("a storage failure answers 500, releases the claim and leaves no half-made row, so the provider's retry works", async () => {
    failUploads = true;
    const body = postmarkMessage({ attachments: [pdf] });
    expect((await post(body)).status).toBe(500);
    expect(docs()).toEqual([]);
    expect(admin._rows("integration_webhook_events")).toEqual([]);
    failUploads = false;
    expect((await post(body)).status).toBe(200);
    expect(docs()).toHaveLength(1);
  });
});
