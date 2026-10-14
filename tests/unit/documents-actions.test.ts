/**
 * Server-action behaviour for Phase 16 with the session and the database replaced by fakes:
 *   - permission gating (a member without the permission is refused before the service role is even created;
 *     documents.* is NOT implied by contacts.*)
 *   - patient documents are switched off until an administrator confirms the storage region
 *   - erasure removes the patient's document files first and stops (changing nothing) if that fails
 *   - opening a document is recorded and a blocked (infected) file is never served
 * No network and no real storage. Synthetic ids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "@/lib/auth/can";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  settings: {} as Record<string, unknown>,
  admin: null as unknown,
  access: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", async () => {
  const can = (await import("@/lib/auth/can")) as { assertCan: (m: unknown, p: string) => void };
  const member = () => ({
    userId: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    roleId: "r",
    roleName: "Test",
    status: "active" as const,
    permissions: state.permissions,
    org: { name: "Test", timezone: "Asia/Dubai", settings: state.settings, is_training: false },
    profile: { first_name: "T", last_name: "U" },
    user: { email: "t@example.test" },
    orgs: [],
  });
  return {
    requirePerm: async (p: string) => {
      const m = member();
      can.assertCan(m, p);
      return m;
    },
    requireMember: async () => member(),
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls++;
    if (!state.admin)
      throw new Error("the service role must not be reached by an unauthorised call");
    return state.admin;
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: async () => {} }));
vi.mock("@/lib/security/access-log", () => ({
  recordAccess: async (_a: unknown, _m: unknown, input: unknown) => {
    state.access.push(input);
  },
}));
vi.mock("@/lib/notifications", () => ({ createNotification: async () => {} }));

import * as docs from "@/app/(app)/contacts/documents/actions";
import * as media from "@/app/(app)/media/actions";
import * as docSettings from "@/app/(app)/settings/documents/actions";
import * as privacy from "@/app/(app)/settings/privacy/actions";

const ID = "00000000-0000-4000-8000-0000000000aa";
const ID2 = "00000000-0000-4000-8000-0000000000bb";
const as = (...permissions: string[]) => {
  state.permissions = permissions;
  state.adminCalls = 0;
  state.admin = null;
  state.settings = {};
  state.access = [];
};

/** Every document action with arguments that pass validation, so a refusal can only come from permissions. */
const docCalls: Array<[string, () => Promise<unknown>, "view" | "manage"]> = [
  ["listContactDocuments", () => docs.listContactDocuments(ID), "view"],
  ["getDocumentUrl", () => docs.getDocumentUrl({ id: ID, mode: "view" }), "view"],
  ["listDocumentAccess", () => docs.listDocumentAccess(ID), "manage"],
  [
    "prepareDocumentUpload",
    () =>
      docs.prepareDocumentUpload({
        contact_id: ID,
        title: "Card",
        category: "insurance_card",
        mime_type: "application/pdf",
        size: 1000,
      }),
    "manage",
  ],
  ["finalizeDocumentUpload", () => docs.finalizeDocumentUpload(ID), "manage"],
  ["abandonDocumentUpload", () => docs.abandonDocumentUpload(ID), "manage"],
  [
    "updateDocument",
    () => docs.updateDocument({ id: ID, title: "x", category: "other" }),
    "manage",
  ],
  ["deleteDocument", () => docs.deleteDocument(ID), "manage"],
  ["rescanDocument", () => docs.rescanDocument(ID), "manage"],
];

describe("patient document actions: permission gating", () => {
  beforeEach(() => as());

  it.each(docCalls)(
    "%s refuses a member who has only contacts.* and inbox rights",
    async (_n, call) => {
      as(
        "contacts.view",
        "contacts.manage",
        "contacts.export",
        "inbox.view_all",
        "inbox.send",
        "settings.manage",
      );
      const res = (await call()) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/permission/);
      expect(state.adminCalls).toBe(0);
    },
  );

  it.each(docCalls.filter(([, , level]) => level === "manage"))(
    "%s refuses a viewer (documents.view alone cannot change anything)",
    async (_n, call) => {
      as("documents.view", "contacts.view");
      const res = (await call()) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(state.adminCalls).toBe(0);
    },
  );

  it.each(docCalls.filter(([, , level]) => level === "view"))(
    "%s lets a viewer through to the data layer",
    async (_n, call) => {
      as("documents.view");
      await expect(call()).rejects.toThrow(/service role must not be reached/);
      expect(state.adminCalls).toBe(1);
    },
  );

  it("documents.manage alone does not let a member read documents", async () => {
    as("documents.manage");
    const res = (await docs.getDocumentUrl({ id: ID, mode: "download" })) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(state.adminCalls).toBe(0);
  });

  it("refuses malformed ids before touching data", async () => {
    as("documents.view", "documents.manage");
    expect(await docs.listContactDocuments("not-a-uuid")).toMatchObject({ ok: false });
    expect(await docs.deleteDocument("../etc/passwd")).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });
});

describe("Media Library actions: permission gating", () => {
  beforeEach(() => as());
  const libCalls: Array<[string, () => Promise<unknown>, "view" | "manage"]> = [
    [
      "prepareLibraryUpload",
      () => media.prepareLibraryUpload({ name: "Poster", mime_type: "image/jpeg", size: 100 }),
      "manage",
    ],
    ["finalizeLibraryUpload", () => media.finalizeLibraryUpload(ID), "manage"],
    ["abandonLibraryUpload", () => media.abandonLibraryUpload(ID), "manage"],
    [
      "updateAsset",
      () => media.updateAsset({ id: ID, name: "x", folder_id: null, tags: [] }),
      "manage",
    ],
    ["deleteAsset", () => media.deleteAsset(ID), "manage"],
    ["createFolder", () => media.createFolder("Offers"), "manage"],
    ["renameFolder", () => media.renameFolder(ID, "Offers"), "manage"],
    ["deleteFolder", () => media.deleteFolder(ID), "manage"],
    ["rescanAsset", () => media.rescanAsset(ID), "manage"],
    ["getAssetUrl", () => media.getAssetUrl(ID), "view"],
    ["getAssetUsage", () => media.getAssetUsage(ID), "view"],
    ["listPickerAssets", () => media.listPickerAssets({}), "view"],
  ];

  it.each(libCalls)("%s refuses a member without library access", async (_n, call) => {
    as(
      "contacts.view",
      "templates.manage",
      "campaigns.create",
      "documents.view",
      "documents.manage",
    );
    const res = (await call()) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(state.adminCalls).toBe(0);
  });

  it.each(libCalls.filter(([, , level]) => level === "manage"))(
    "%s refuses a member who can only view the library",
    async (_n, call) => {
      as("media.view");
      expect(((await call()) as { ok: boolean }).ok).toBe(false);
      expect(state.adminCalls).toBe(0);
    },
  );

  it.each(libCalls.filter(([, , level]) => level === "view"))(
    "%s lets a viewer through",
    async (_n, call) => {
      as("media.view");
      await expect(call()).rejects.toThrow(/service role must not be reached/);
    },
  );
});

describe("Settings, Patient documents: permission gating", () => {
  beforeEach(() => as());
  const calls: Array<[string, () => Promise<unknown>]> = [
    [
      "saveDocumentOptions",
      () => docSettings.saveDocumentOptions({ expiry_lead_days: 14, expiry_task: true }),
    ],
    ["enableDocuments", () => docSettings.enableDocuments("STORAGE REGION APPROVED")],
    ["disableDocuments", () => docSettings.disableDocuments()],
    [
      "saveRetentionPolicy",
      () =>
        docSettings.saveRetentionPolicy({
          category: "referral",
          retain_days: 400,
          auto_delete: false,
        }),
    ],
    ["purgePastRetention", () => docSettings.purgePastRetention("referral")],
    ["scanPendingFiles", () => docSettings.scanPendingFiles()],
  ];

  it.each(calls)("%s needs settings.manage", async (_n, call) => {
    as("documents.manage", "documents.view", "media.manage");
    await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    expect(state.adminCalls).toBe(0);
  });

  it("purging also needs documents.manage", async () => {
    as("settings.manage");
    const res = (await docSettings.purgePastRetention("referral")) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission/);
  });

  it("will not switch documents on without the exact confirmation phrase", async () => {
    as("settings.manage");
    for (const phrase of ["", "yes", "storage region approved", "STORAGE REGION"]) {
      const res = (await docSettings.enableDocuments(phrase)) as { ok: boolean };
      expect(res.ok).toBe(false);
    }
    expect(state.adminCalls).toBe(0);
  });

  it("refuses nonsense retention values", async () => {
    as("settings.manage");
    for (const input of [
      { category: "referral", retain_days: 5, auto_delete: false },
      { category: "referral", retain_days: null, auto_delete: true },
      { category: "referral", retain_days: 99999, auto_delete: false },
    ] as const) {
      const res = (await docSettings.saveRetentionPolicy(input)) as { ok: boolean };
      expect(res.ok).toBe(false);
    }
    expect(state.adminCalls).toBe(0);
  });
});

describe("uploads are off until an administrator confirms the storage region", () => {
  beforeEach(() => as());
  it("prepareDocumentUpload refuses while patient documents are switched off", async () => {
    as("documents.manage");
    const res = (await docs.prepareDocumentUpload({
      contact_id: ID,
      title: "Card",
      category: "insurance_card",
      mime_type: "application/pdf",
      size: 1000,
    })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/switched off/);
    expect(state.adminCalls).toBe(0);
  });

  it("then validates the type and size on the server, whatever the browser did", async () => {
    as("documents.manage");
    state.settings = { documents: { enabled: true } };
    for (const [mime, size] of [
      ["application/x-msdownload", 100],
      ["video/mp4", 100],
      ["application/pdf", 26 * 1024 * 1024],
      ["application/pdf", 0],
    ] as const) {
      const res = (await docs.prepareDocumentUpload({
        contact_id: ID,
        title: "Card",
        category: "other",
        mime_type: mime,
        size,
      })) as { ok: boolean };
      expect(res.ok, `${mime} ${size}`).toBe(false);
    }
    const badCategory = (await docs.prepareDocumentUpload({
      contact_id: ID,
      title: "Card",
      category: "passport",
      mime_type: "application/pdf",
      size: 100,
    })) as { ok: boolean };
    expect(badCategory.ok).toBe(false);
    const badDate = (await docs.prepareDocumentUpload({
      contact_id: ID,
      title: "Card",
      category: "insurance_card",
      expires_on: "2026-02-31",
      mime_type: "application/pdf",
      size: 100,
    })) as { ok: boolean };
    expect(badDate.ok).toBe(false);
    expect(state.adminCalls).toBe(0);
  });
});

/** A chainable fake of the supabase-js query builder, answering by table from a script. */
function fakeAdmin(script: {
  tables?: Record<string, unknown[]>;
  rpc?: (name: string) => { data: unknown; error: unknown };
  removeError?: Record<string, boolean>;
  signedUrl?: string | null;
}) {
  const events: string[] = [];
  const admin = {
    events,
    from(table: string) {
      const rows = script.tables?.[table] ?? [];
      const q: Record<string, unknown> = {};
      const chain = () => q;
      for (const m of [
        "select",
        "eq",
        "in",
        "is",
        "not",
        "lte",
        "lt",
        "gte",
        "order",
        "limit",
        "range",
        "neq",
        "or",
        "contains",
      ])
        q[m] = chain;
      q.insert = () => {
        events.push(`insert:${table}`);
        return q;
      };
      q.update = () => {
        events.push(`update:${table}`);
        return q;
      };
      q.delete = () => {
        events.push(`delete:${table}`);
        return q;
      };
      q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      q.single = async () => ({ data: rows[0] ?? null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
      return q;
    },
    rpc: async (name: string) => {
      events.push(`rpc:${name}`);
      return script.rpc?.(name) ?? { data: {}, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          events.push(`remove:${bucket}:${paths.length}`);
          return { error: script.removeError?.[bucket] ? { message: "down" } : null };
        },
        createSignedUrl: async (_p: string, ttl: number, opts?: { download?: unknown }) => {
          events.push(`sign:${bucket}:${ttl}:${opts?.download ? "download" : "view"}`);
          return script.signedUrl === null
            ? { data: null, error: { message: "x" } }
            : {
                data: { signedUrl: script.signedUrl ?? "https://storage.example.test/signed" },
                error: null,
              };
        },
      }),
    },
  };
  return admin;
}

describe("erasure covers the patient's documents", () => {
  const REQ = {
    id: ID,
    kind: "erasure",
    status: "approved",
    contact_id: ID2,
    requested_by: "someone-else",
  };
  const docId = "00000000-0000-4000-8000-0000000000cc";
  const orgId = "00000000-0000-4000-8000-000000000002";
  const doc = { id: docId, storage_path: `${orgId}/${ID2}/${docId}.pdf` };

  beforeEach(() => as());

  it("removes document files (and inbox media) before the database function runs", async () => {
    as("privacy.manage");
    const admin = fakeAdmin({
      tables: { privacy_requests: [REQ], conversations: [], patient_documents: [doc] },
    });
    state.admin = admin;
    const res = (await privacy.executeErasure(ID)) as { ok: boolean };
    expect(res.ok).toBe(true);
    const removeAt = admin.events.indexOf("remove:patient-documents:1");
    const rpcAt = admin.events.indexOf("rpc:erase_contact");
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(rpcAt).toBeGreaterThan(removeAt);
  });

  it("changes nothing when a document file cannot be removed", async () => {
    as("privacy.manage");
    const admin = fakeAdmin({
      tables: { privacy_requests: [REQ], conversations: [], patient_documents: [doc] },
      removeError: { "patient-documents": true },
    });
    state.admin = admin;
    const res = (await privacy.executeErasure(ID)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing else was changed/);
    expect(admin.events).not.toContain("rpc:erase_contact");
    expect(admin.events.some((e) => e.startsWith("update:privacy_requests"))).toBe(false);
  });

  it("refuses to go on when a stored path is not a document path in this org", async () => {
    as("privacy.manage");
    const admin = fakeAdmin({
      tables: {
        privacy_requests: [REQ],
        conversations: [],
        patient_documents: [{ id: docId, storage_path: `${ID}/${ID2}/${docId}.pdf` }],
      },
    });
    state.admin = admin;
    const res = (await privacy.executeErasure(ID)) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(admin.events).not.toContain("rpc:erase_contact");
    expect(admin.events.some((e) => e.startsWith("remove:"))).toBe(false);
  });

  it("works for a patient with no documents", async () => {
    as("privacy.manage");
    const admin = fakeAdmin({
      tables: { privacy_requests: [REQ], conversations: [], patient_documents: [] },
    });
    state.admin = admin;
    expect(((await privacy.executeErasure(ID)) as { ok: boolean }).ok).toBe(true);
    expect(admin.events).toContain("rpc:erase_contact");
  });
});

describe("opening a document", () => {
  const orgId = "00000000-0000-4000-8000-000000000002";
  const docId = "00000000-0000-4000-8000-0000000000cc";
  const row = (over: Record<string, unknown> = {}) => ({
    id: docId,
    org_id: orgId,
    contact_id: ID2,
    category: "lab_report",
    title: "Synthetic report",
    status: "ready",
    scan_status: "unscanned",
    storage_path: `${orgId}/${ID2}/${docId}.pdf`,
    ...over,
  });
  beforeEach(() => as("documents.view"));

  it("hands out a 60-second link and records who opened what, without the title", async () => {
    const admin = fakeAdmin({ tables: { patient_documents: [row()] } });
    state.admin = admin;
    const res = (await docs.getDocumentUrl({ id: docId, mode: "view" })) as {
      ok: boolean;
      data?: { url: string };
    };
    expect(res.ok).toBe(true);
    expect(admin.events).toContain("sign:patient-documents:60:view");
    expect(state.access).toEqual([
      {
        entity: "document",
        entityId: docId,
        action: "view",
        detail: { category: "lab_report", contact_id: ID2 },
      },
    ]);
    expect(JSON.stringify(state.access)).not.toContain("Synthetic");
  });

  it("records a download as a download and asks storage for a file name built from the title", async () => {
    const admin = fakeAdmin({ tables: { patient_documents: [row()] } });
    state.admin = admin;
    await docs.getDocumentUrl({ id: docId, mode: "download" });
    expect(admin.events).toContain("sign:patient-documents:60:download");
    expect((state.access[0] as { action: string }).action).toBe("download");
  });

  it("never serves a file the malware scan blocked, and records nothing for it", async () => {
    state.admin = fakeAdmin({ tables: { patient_documents: [row({ scan_status: "infected" })] } });
    const res = (await docs.getDocumentUrl({ id: docId, mode: "view" })) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/malware/);
    expect(state.access).toEqual([]);
  });

  it("still serves a file that has not been scanned (it is flagged in the screen, not hidden)", async () => {
    state.admin = fakeAdmin({ tables: { patient_documents: [row({ scan_status: "unscanned" })] } });
    expect(((await docs.getDocumentUrl({ id: docId, mode: "view" })) as { ok: boolean }).ok).toBe(
      true,
    );
  });

  it("refuses an unfinished upload, another document's path and a missing row", async () => {
    state.admin = fakeAdmin({ tables: { patient_documents: [row({ status: "pending" })] } });
    expect(((await docs.getDocumentUrl({ id: docId })) as { ok: boolean }).ok).toBe(false);
    state.admin = fakeAdmin({
      tables: { patient_documents: [row({ storage_path: `${orgId}/${ID2}/${ID}.pdf` })] },
    });
    expect(((await docs.getDocumentUrl({ id: docId })) as { ok: boolean }).ok).toBe(false);
    state.admin = fakeAdmin({
      tables: { patient_documents: [row({ storage_path: `${ID}/${ID2}/${docId}.pdf` })] },
    });
    expect(((await docs.getDocumentUrl({ id: docId })) as { ok: boolean }).ok).toBe(false);
    state.admin = fakeAdmin({ tables: { patient_documents: [] } });
    expect(((await docs.getDocumentUrl({ id: docId })) as { ok: boolean }).ok).toBe(false);
    expect(state.access).toEqual([]);
  });

  it("still opens a document whose file lives under the patient it was merged from", async () => {
    state.admin = fakeAdmin({
      tables: {
        patient_documents: [row({ contact_id: ID, storage_path: `${orgId}/${ID2}/${docId}.pdf` })],
      },
    });
    expect(((await docs.getDocumentUrl({ id: docId })) as { ok: boolean }).ok).toBe(true);
  });
});

describe("deleting a document", () => {
  const orgId = "00000000-0000-4000-8000-000000000002";
  const docId = "00000000-0000-4000-8000-0000000000cc";
  const row = {
    id: docId,
    contact_id: ID2,
    category: "other",
    size_bytes: 10,
    storage_path: `${orgId}/${ID2}/${docId}.pdf`,
  };
  beforeEach(() => as("documents.manage"));

  it("removes the file before the record", async () => {
    const admin = fakeAdmin({ tables: { patient_documents: [row] } });
    state.admin = admin;
    expect(((await docs.deleteDocument(docId)) as { ok: boolean }).ok).toBe(true);
    expect(admin.events.indexOf("remove:patient-documents:1")).toBeLessThan(
      admin.events.indexOf("delete:patient_documents"),
    );
  });

  it("keeps the record when the file cannot be removed (so it can be retried)", async () => {
    const admin = fakeAdmin({
      tables: { patient_documents: [row] },
      removeError: { "patient-documents": true },
    });
    state.admin = admin;
    const res = (await docs.deleteDocument(docId)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(admin.events).not.toContain("delete:patient_documents");
  });
});
