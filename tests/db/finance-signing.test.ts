/**
 * Phase 22C: digital signatures, database side. A voucher step and a close sign-off stored together with a personal
 * signature (fin_voucher_act_signed / fin_close_sign_signed): a statement that does not match the step, a revoked or
 * someone else's certificate, a stale signature or a step that cannot be signed fails the whole step (the approval is not
 * consumed). Who reads the signatures (the document's own readers), the service-only certificate and sealed-PDF tables,
 * append-only rules and the cross-org boundary. Certificates are generated in the test (node-forge); synthetic names only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import { currentSignatures, type StoredSignature } from "@/lib/signing/approvals";
import { signDetached } from "@/lib/signing/cms";
import { openP12, type SigningIdentity } from "@/lib/signing/p12";
import {
  approvalStatement,
  type StatementDocType,
  type StatementStep,
} from "@/lib/signing/statement";

import { makeTestCert } from "../unit/signing/make-cert";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const HEX = (n: number) => n.toString(16).padStart(64, "0");

describe.skipIf(!TEST_DATABASE_URL)("Finance digital signatures (Phase 22C)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const ids: Record<string, SigningIdentity> = {};
  const certIds: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint;
  const code = (e: unknown) => (e as { code?: string } | null)?.code;
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );

  /** Stores a person's certificate row as the server action would (the encrypted blob is a placeholder here). */
  const addCertificate = (org: string, user: string, id: SigningIdentity) =>
    svc(async () => {
      const { rows } = await q(
        "insert into public.fin_signing_certificates (org_id, user_id, p12_enc, subject, subject_cn, issuer, issuer_cn, serial_hex, fingerprint_sha256, valid_from, valid_to) values ($1, $2, 'v1:test:test:test', $3, $4, $5, $6, $7, $8, $9, $10) returning id",
        [
          org,
          user,
          id.info.subject,
          id.info.subjectCn,
          id.info.issuer,
          id.info.issuerCn,
          id.info.serialHex,
          id.info.fingerprint,
          id.info.validFrom,
          id.info.validTo,
        ],
      );
      return rows[0].id as string;
    });

  const signature = (a: {
    org: string;
    docType: StatementDocType;
    docId: string;
    step: StatementStep;
    user: string;
    who: string;
    bound: string;
    remarks?: string | null;
    signedAt?: Date;
    certificateId?: string;
  }) => {
    const s = approvalStatement({
      docType: a.docType,
      docId: a.docId,
      docRef: "REF-TEST",
      orgId: a.org,
      step: a.step,
      signerId: a.user,
      boundSha256: a.bound,
      remarks: a.remarks ?? null,
      signedAt: a.signedAt ?? new Date(),
    });
    const cms = signDetached({
      content: Buffer.from(s.text),
      identity: ids[a.who],
      signingTime: new Date(s.statement.signed_at),
    });
    return {
      certificate_id: a.certificateId ?? certIds[a.who],
      fingerprint: ids[a.who].info.fingerprint,
      statement: s.text,
      cms: cms.toString("base64"),
    };
  };

  const newVoucher = async (amount: number) => {
    const doc = await svc(async () => {
      const { rows } = await q(
        "insert into public.fin_documents (org_id, kind, storage_path, mime_type, size_bytes, sha256, status) values ($1::uuid, 'voucher_backup', $1::text || '/' || gen_random_uuid() || '.pdf', 'application/pdf', 1000, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'ready') returning id",
        [orgA],
      );
      return rows[0].id as string;
    });
    return svc(async () => {
      const { rows } = await q(
        "select public.fin_voucher_save($1, $2, null, $3::jsonb, '{}'::uuid[], $4::uuid[]) as r",
        [
          orgA,
          users.maker,
          JSON.stringify({
            voucher_date: "2026-10-02",
            payee_name: "Supplier Test 01",
            amount,
            category: "Equipment",
            narration: "Synthetic voucher",
            branch_code: "P",
            pay_from: "BANK-MAIN",
          }),
          [doc],
        ],
      );
      const id = rows[0].r.id as string;
      await q("select public.fin_voucher_act($1, $2, $3, 'submit', null, null, null)", [
        orgA,
        id,
        users.maker,
      ]);
      return id;
    });
  };
  const voucher = (id: string) =>
    svc(
      async () =>
        (await q("select * from public.fin_payment_vouchers where id = $1", [id])).rows[0],
    );
  const actSigned = (
    id: string,
    user: string,
    action: string,
    hash: string,
    sig: unknown,
    remarks: string | null = null,
  ) =>
    svc(() =>
      q("select public.fin_voucher_act_signed($1, $2, $3, $4, $5, $6, $7::jsonb) as r", [
        orgA,
        id,
        user,
        action,
        hash,
        remarks,
        JSON.stringify(sig),
      ]),
    );
  const storedRows = (docId: string): Promise<StoredSignature[]> =>
    svc(async () =>
      (
        await q(
          "select id, step, user_id, statement, statement_sha256, bound_sha256, cms, cert_subject, cert_subject_cn, cert_issuer, cert_issuer_cn, cert_serial, cert_fingerprint, cert_valid_from::text, cert_valid_to::text, step_at::text from public.fin_approval_signatures where doc_id = $1 order by step_at",
          [docId],
        )
      ).rows.map((r) => ({ ...r, cms: r.cms as Buffer })),
    );

  let v1: string; // signed by the Finance Manager and the CEO
  let closeId: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "maker", "fm", "ceo", "dept", "billing", "closer"])
      users[n] = await createAuthUser(c, `${n}-signing@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do nothing",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions) values ($1, 'Close viewer', 'test', '[\"finance.close.view\"]'::jsonb)",
        [orgA],
      );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("maker", "Finance");
      await member("fm", "Finance Manager");
      await member("ceo", "CEO");
      await member("dept", "Department head");
      await member("billing", "Billing");
      await member("closer", "Close viewer");
    });
    for (const n of ["fm", "ceo", "bob"]) {
      const t = makeTestCert({ cn: `Signer Test ${n}`, fresh: true });
      ids[n] = openP12(t.p12, t.pin);
    }
    certIds.fm = await addCertificate(orgA, users.fm, ids.fm);
    certIds.ceo = await addCertificate(orgA, users.ceo, ids.ceo);
    certIds.bob = await addCertificate(orgB, users.bob, ids.bob);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("stores a verify and an authorise step with their signatures in one transaction, bound to the step time", async () => {
    v1 = await newVoucher(20000); // Tier 3: Finance Manager, then CEO
    const hash = (await voucher(v1)).content_sha256 as string;
    await actSigned(
      v1,
      users.fm,
      "check",
      hash,
      signature({
        org: orgA,
        docType: "payment_voucher",
        docId: v1,
        step: "check",
        user: users.fm,
        who: "fm",
        bound: hash,
        remarks: "Checked against the quotation",
      }),
      "Checked against the quotation",
    );
    await actSigned(
      v1,
      users.ceo,
      "approve_ceo",
      hash,
      signature({
        org: orgA,
        docType: "payment_voucher",
        docId: v1,
        step: "approve_ceo",
        user: users.ceo,
        who: "ceo",
        bound: hash,
      }),
    );
    const v = await voucher(v1);
    expect(v.status).toBe("approved");
    const rows = await storedRows(v1);
    expect(rows.map((r) => r.step)).toEqual(["check", "approve_ceo"]);
    expect(rows[0].statement).not.toContain("quotation"); // the remarks travel as a hash only
    const views = currentSignatures({
      docType: "payment_voucher",
      docId: v1,
      boundSha256: hash,
      steps: [
        { step: "check", userId: v.checked_by, at: new Date(v.checked_at).toISOString() },
        {
          step: "approve_ceo",
          userId: v.ceo_approved_by,
          at: new Date(v.ceo_approved_at).toISOString(),
        },
      ],
      rows,
    });
    expect(views.map((x) => [x.step, x.status])).toEqual([
      ["check", "valid"],
      ["approve_ceo", "valid"],
    ]);
  });

  it("fails the whole step when the signature does not match it, so the approval is never consumed", async () => {
    const id = await newVoucher(21000);
    const hash = (await voucher(id)).content_sha256 as string;
    const base = {
      org: orgA,
      docType: "payment_voucher" as const,
      docId: id,
      step: "check" as const,
      user: users.fm,
      who: "fm",
      bound: hash,
    };
    const cases: Array<[string, unknown, string | null]> = [
      ["other hash", signature({ ...base, bound: HEX(7) }), null],
      ["other step", signature({ ...base, step: "approve_ceo" }), null],
      ["other document", signature({ ...base, docId: v1 }), null],
      ["remarks differ", signature({ ...base, remarks: "something else" }), "the real remarks"],
      ["stale", signature({ ...base, signedAt: new Date(Date.now() - 3600_000) }), null],
      [
        "someone else's certificate",
        signature({ ...base, who: "fm", certificateId: certIds.ceo }),
        null,
      ],
    ];
    const hints: Record<string, string | undefined> = {};
    for (const [name, sig, remarks] of cases)
      hints[name] = hint(await failure(actSigned(id, users.fm, "check", hash, sig, remarks)));
    expect(hints).toEqual({
      "other hash": "signature_invalid",
      "other step": "signature_invalid",
      "other document": "signature_invalid",
      "remarks differ": "signature_invalid",
      stale: "signature_stale",
      "someone else's certificate": "certificate_revoked",
    });
    // a step that cannot be signed
    expect(
      hint(
        await failure(
          actSigned(id, users.maker, "submit", hash, signature({ ...base, user: users.maker })),
        ),
      ),
    ).toBe("signature_step");
    const v = await voucher(id);
    expect(v.status).toBe("submitted");
    expect(v.checked_by).toBeNull();
    expect(await storedRows(id)).toEqual([]);
    // the step's own rules still apply under the signed variant (the maker holds no checker key)
    expect(
      hint(
        await failure(
          actSigned(id, users.maker, "check", hash, signature({ ...base, user: users.maker })),
        ),
      ),
    ).toBe("not_permitted");
  });

  it("refuses a revoked certificate, keeps one active certificate per person and drops the key on revocation", async () => {
    const id = await newVoucher(22000);
    const hash = (await voucher(id)).content_sha256 as string;
    const t = makeTestCert({ cn: "Signer Test fm2", fresh: true });
    ids.fm2 = openP12(t.p12, t.pin);
    // a second active certificate for the same person is refused
    expect(code(await failure(addCertificate(orgA, users.fm, ids.fm2)))).toBe("23505");
    // revoking must drop the key material too
    expect(
      code(
        await failure(
          svc(() =>
            q("update public.fin_signing_certificates set revoked_at = now() where id = $1", [
              certIds.fm,
            ]),
          ),
        ),
      ),
    ).toBe("42501");
    await svc(() =>
      q(
        "update public.fin_signing_certificates set revoked_at = now(), p12_enc = null where id = $1",
        [certIds.fm],
      ),
    );
    expect(
      hint(
        await failure(
          actSigned(
            id,
            users.fm,
            "check",
            hash,
            signature({
              org: orgA,
              docType: "payment_voucher",
              docId: id,
              step: "check",
              user: users.fm,
              who: "fm",
              bound: hash,
            }),
          ),
        ),
      ),
    ).toBe("certificate_revoked");
    expect((await voucher(id)).status).toBe("submitted");
    // a revoked certificate never changes again, and certificates are never deleted
    expect(
      code(
        await failure(
          svc(() =>
            q("update public.fin_signing_certificates set subject = 'x' where id = $1", [
              certIds.fm,
            ]),
          ),
        ),
      ),
    ).toBe("42501");
    expect(
      code(
        await failure(
          svc(() => q("delete from public.fin_signing_certificates where id = $1", [certIds.fm])),
        ),
      ),
    ).toBe("42501");
    // the replacement works
    certIds.fm = await addCertificate(orgA, users.fm, ids.fm2);
    ids.fm = ids.fm2;
    await actSigned(
      id,
      users.fm,
      "check",
      hash,
      signature({
        org: orgA,
        docType: "payment_voucher",
        docId: id,
        step: "check",
        user: users.fm,
        who: "fm",
        bound: hash,
      }),
    );
    expect((await voucher(id)).status).toBe("checked");
  });

  it("signs both close sign-offs with the sign-off itself", async () => {
    // the snapshot hash is the sha256 of the snapshot's jsonb text (checked by the close trigger)
    const snapshot = { month: "2026-08-01", note: "synthetic" };
    const { closeRow, hash } = await svc(async () => {
      const { rows } = await q(
        "insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at) values ($1, '2026-08-01', 'built', $2::jsonb, encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex'), now()) returning id, snapshot_hash",
        [orgA, JSON.stringify(snapshot)],
      );
      return { closeRow: rows[0].id as string, hash: rows[0].snapshot_hash as string };
    });
    closeId = closeRow;
    const sign = (
      user: string,
      who: string,
      step: "finance" | "ceo",
      note: string | null,
      sig?: unknown,
    ) =>
      svc(() =>
        q("select public.fin_close_sign_signed($1, $2, $3, $4, $5, $6, $7::jsonb) as r", [
          orgA,
          closeId,
          user,
          step,
          hash,
          note,
          JSON.stringify(
            sig ??
              signature({
                org: orgA,
                docType: "close_pack",
                docId: closeId,
                step,
                user,
                who,
                bound: hash,
                remarks: note,
              }),
          ),
        ]),
      );
    // a wrong statement leaves the month unsigned
    expect(
      hint(
        await failure(
          sign(
            users.fm,
            "fm",
            "finance",
            null,
            signature({
              org: orgA,
              docType: "close_pack",
              docId: closeId,
              step: "ceo",
              user: users.fm,
              who: "fm",
              bound: hash,
            }),
          ),
        ),
      ),
    ).toBe("signature_invalid");
    expect(
      (await svc(() => q("select status from public.fin_period_closes where id = $1", [closeId])))
        .rows[0].status,
    ).toBe("built");
    await sign(users.fm, "fm", "finance", "Reviewed");
    await sign(users.ceo, "ceo", "ceo", null);
    const close = (
      await svc(() => q("select * from public.fin_period_closes where id = $1", [closeId]))
    ).rows[0];
    expect(close.status).toBe("locked");
    const views = currentSignatures({
      docType: "close_pack",
      docId: closeId,
      boundSha256: hash,
      steps: [
        {
          step: "finance",
          userId: close.finance_signed_by,
          at: new Date(close.finance_signed_at).toISOString(),
        },
        {
          step: "ceo",
          userId: close.ceo_signed_by,
          at: new Date(close.ceo_signed_at).toISOString(),
        },
      ],
      rows: await storedRows(closeId),
    });
    expect(views.map((x) => [x.step, x.status])).toEqual([
      ["finance", "valid"],
      ["ceo", "valid"],
    ]);
  });

  it("shows signatures exactly to the readers of their document, never across orgs, and nobody writes them", async () => {
    const count = (u: string, docId: string) =>
      asUser(c, users[u], async () =>
        Number(
          (
            await q("select count(*) as n from public.fin_approval_signatures where doc_id = $1", [
              docId,
            ])
          ).rows[0].n,
        ),
      );
    // voucher signatures: Finance, Finance Manager, CEO and the admin read the voucher; billing and the close viewer do not;
    // the department head reads only Tier 2 vouchers (this is Tier 3)
    expect({
      alice: await count("alice", v1),
      maker: await count("maker", v1),
      fm: await count("fm", v1),
      ceo: await count("ceo", v1),
      dept: await count("dept", v1),
      billing: await count("billing", v1),
      closer: await count("closer", v1),
      bob: await count("bob", v1),
    }).toEqual({ alice: 2, maker: 2, fm: 2, ceo: 2, dept: 0, billing: 0, closer: 0, bob: 0 });
    // close signatures follow fin_period_closes: the close viewer reads them, billing and the department head do not
    expect({
      closer: await count("closer", closeId),
      billing: await count("billing", closeId),
      dept: await count("dept", closeId),
      bob: await count("bob", closeId),
    }).toEqual({ closer: 2, billing: 0, dept: 0, bob: 0 });
    // no direct writes, even by the org's own admin
    for (const u of ["alice", "fm"]) {
      const e = await failure(
        asUser(c, users[u], () =>
          q(
            "insert into public.fin_approval_signatures (org_id, doc_kind, doc_id, step, user_id, statement, statement_sha256, bound_sha256, cms, cert_subject, cert_issuer, cert_serial, cert_fingerprint, cert_valid_from, cert_valid_to) values ($1, 'payment_voucher', $2, 'check', $3, '{}', repeat('a', 64), repeat('a', 64), decode(repeat('30', 64), 'hex'), 's', 'i', '1', repeat('a', 64), now(), now() + interval '1 day')",
            [orgA, v1, users[u]],
          ),
        ),
      );
      expect(code(e), u).toBe("42501");
    }
    // append-only, even for the service role
    expect(
      code(
        await failure(
          svc(() =>
            q(
              "update public.fin_approval_signatures set bound_sha256 = repeat('e', 64) where doc_id = $1",
              [v1],
            ),
          ),
        ),
      ),
    ).toBe("42501");
    expect(
      code(
        await failure(
          svc(() => q("delete from public.fin_approval_signatures where doc_id = $1", [v1])),
        ),
      ),
    ).toBe("42501");
    // org B's own signer cannot sign org A's voucher with an org B certificate
    const id = await newVoucher(23000);
    const hash = (await voucher(id)).content_sha256 as string;
    expect(
      hint(
        await failure(
          actSigned(
            id,
            users.fm,
            "check",
            hash,
            signature({
              org: orgA,
              docType: "payment_voucher",
              docId: id,
              step: "check",
              user: users.fm,
              who: "bob",
              bound: hash,
              certificateId: certIds.bob,
            }),
          ),
        ),
      ),
    ).toBe("certificate_revoked");
  });

  it("keeps certificates and sealed PDFs service-only, one sealed copy per document and hash, never changed", async () => {
    for (const u of ["alice", "fm", "ceo"])
      await asUser(c, users[u], async () => {
        for (const t of ["fin_signing_certificates", "fin_sealed_documents"])
          expect(
            Number((await q(`select count(*) as n from public.${t}`)).rows[0].n),
            `${u} ${t}`,
          ).toBe(0);
      });
    const insert = () =>
      svc(() =>
        q(
          "insert into public.fin_sealed_documents (org_id, doc_kind, doc_id, bound_sha256, pdf, seal_subject, seal_fingerprint) values ($1, 'voucher_certificate', $2, $3, convert_to('%PDF-1.7 ' || repeat('y', 300), 'UTF8'), 'CN=Seal Test Org', repeat('d', 64)) returning pdf_sha256",
          [orgA, v1, HEX(1)],
        ),
      );
    const first = await insert();
    expect(first.rows[0].pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(code(await failure(insert()))).toBe("23505");
    expect(
      code(
        await failure(
          svc(() =>
            q("update public.fin_sealed_documents set seal_subject = 'x' where doc_id = $1", [v1]),
          ),
        ),
      ),
    ).toBe("42501");
    expect(
      code(
        await failure(
          svc(() => q("delete from public.fin_sealed_documents where doc_id = $1", [v1])),
        ),
      ),
    ).toBe("42501");
    const e = await failure(
      asUser(c, users.alice, () =>
        q(
          "insert into public.fin_signing_certificates (org_id, user_id, p12_enc, subject, issuer, serial_hex, fingerprint_sha256, valid_from, valid_to) values ($1, $2, 'v1:a:b:c', 's', 'i', '1', repeat('a', 64), now(), now() + interval '1 day')",
          [orgA, users.alice],
        ),
      ),
    );
    expect(code(e)).toBe("42501");
  });
});
