/**
 * Phase 20d close-with-enquiry: input schema, the checks made before anything is written, and the order in which the
 * enquiry service is called. Service calls are fakes; synthetic ids only.
 */
import { describe, expect, it } from "vitest";

import {
  applyCloseEnquiry,
  apptDateValue,
  closeEnquiryPartSchema,
  validateCloseEnquiry,
  type CloseEnquiryDeps,
  type CloseEnquiryPart,
  type CloseEnquiryTarget,
} from "@/lib/inbox/close-enquiry";

const CONTACT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PIPE = "33333333-3333-4333-8333-333333333333";
const S1 = "44444444-4444-4444-8444-444444444444";
const S2 = "55555555-5555-4555-8555-555555555555";
const ENQ = "66666666-6666-4666-8666-666666666666";

const target: CloseEnquiryTarget = {
  id: ENQ,
  status: "open",
  stage_id: S1,
  pipeline_id: PIPE,
  contact_id: CONTACT,
};

function fakeDeps() {
  const calls: string[] = [];
  const deps: CloseEnquiryDeps = {
    async create(i) {
      calls.push(
        `create:${i.pipelineId}:${i.stageId ?? "first"}:${i.contactId}:${i.apptDate ?? "-"}`,
      );
      return { id: "new-enquiry", number: 42 };
    },
    async moveStage(id, stageId) {
      calls.push(`stage:${id}:${stageId}`);
    },
    async setStatus(id, status, reason) {
      calls.push(`status:${id}:${status}:${reason ?? "-"}`);
    },
    async setApptDate(id, date) {
      calls.push(`appt:${id}:${date ?? "-"}`);
    },
  };
  return { deps, calls };
}

const parse = (v: unknown) => closeEnquiryPartSchema.parse(v) as CloseEnquiryPart;

describe("schema", () => {
  it("accepts a create and an update, and defaults a new enquiry to open", () => {
    expect(parse({ mode: "create", pipeline_id: PIPE, title: "WhatsApp enquiry" })).toMatchObject({
      status: "open",
    });
    expect(parse({ mode: "update", enquiry_id: ENQ, status: "won" })).toMatchObject({
      status: "won",
    });
  });
  it("rejects a blank title, a bad date and an unknown status", () => {
    expect(
      closeEnquiryPartSchema.safeParse({ mode: "create", pipeline_id: PIPE, title: " " }).success,
    ).toBe(false);
    expect(
      closeEnquiryPartSchema.safeParse({ mode: "update", enquiry_id: ENQ, appt_date: "next week" })
        .success,
    ).toBe(false);
    expect(
      closeEnquiryPartSchema.safeParse({ mode: "update", enquiry_id: ENQ, status: "maybe" })
        .success,
    ).toBe(false);
  });
});

describe("validateCloseEnquiry (before anything is written)", () => {
  const ctx = { contactId: CONTACT, target, pipelineStageIds: [S1, S2] };
  it("requires a reason for lost and disqualified, from the list or free text", () => {
    expect(
      validateCloseEnquiry(parse({ mode: "update", enquiry_id: ENQ, status: "lost" }), ctx),
    ).toMatch(/reason is required/);
    expect(
      validateCloseEnquiry(
        parse({ mode: "update", enquiry_id: ENQ, status: "lost", reason: "Too expensive" }),
        ctx,
      ),
    ).toBeNull();
    expect(
      validateCloseEnquiry(
        parse({
          mode: "create",
          pipeline_id: PIPE,
          title: "t",
          status: "disqualified",
          reason: "",
        }),
        { ...ctx, target: null },
      ),
    ).toMatch(/reason is required/);
  });
  it("refuses another patient's enquiry, a missing one and a stage from another pipeline", () => {
    expect(
      validateCloseEnquiry(parse({ mode: "update", enquiry_id: ENQ }), {
        ...ctx,
        target: { ...target, contact_id: OTHER },
      }),
    ).toMatch(/another patient/);
    expect(
      validateCloseEnquiry(parse({ mode: "update", enquiry_id: ENQ }), { ...ctx, target: null }),
    ).toMatch(/no longer exists/);
    expect(
      validateCloseEnquiry(parse({ mode: "update", enquiry_id: ENQ, stage_id: PIPE }), ctx),
    ).toMatch(/not in the enquiry's pipeline/);
  });
});

describe("applyCloseEnquiry (through the enquiry service, in order)", () => {
  it("creates an enquiry for the patient and then sets a closing status last", async () => {
    const { deps, calls } = fakeDeps();
    const r = await applyCloseEnquiry(
      deps,
      parse({
        mode: "create",
        pipeline_id: PIPE,
        title: "t",
        status: "lost",
        reason: "No answer",
        appt_date: "2026-11-02",
      }),
      { contactId: CONTACT, channelId: null, target: null },
    );
    expect(calls).toEqual([
      `create:${PIPE}:first:${CONTACT}:2026-11-02T00:00:00.000Z`,
      "status:new-enquiry:lost:No answer",
    ]);
    expect(r).toEqual({
      enquiryId: "new-enquiry",
      number: 42,
      created: true,
      steps: ["created", "status:lost"],
    });
  });

  it("an open new enquiry is just created", async () => {
    const { deps, calls } = fakeDeps();
    const r = await applyCloseEnquiry(
      deps,
      parse({ mode: "create", pipeline_id: PIPE, stage_id: S2, title: "t" }),
      {
        contactId: CONTACT,
        channelId: null,
        target: null,
      },
    );
    expect(calls).toEqual([`create:${PIPE}:${S2}:${CONTACT}:-`]);
    expect(r.steps).toEqual(["created"]);
  });

  it("updates stage, then the requested appointment date, then the status", async () => {
    const { deps, calls } = fakeDeps();
    const r = await applyCloseEnquiry(
      deps,
      parse({
        mode: "update",
        enquiry_id: ENQ,
        stage_id: S2,
        status: "won",
        appt_date: "2026-11-05",
      }),
      { contactId: CONTACT, channelId: null, target },
    );
    expect(calls).toEqual([
      `stage:${ENQ}:${S2}`,
      `appt:${ENQ}:2026-11-05T00:00:00.000Z`,
      `status:${ENQ}:won:-`,
    ]);
    expect(r.steps).toEqual(["stage", "appt_date", "status:won"]);
  });

  it("changes nothing that was left as it is", async () => {
    const { deps, calls } = fakeDeps();
    const r = await applyCloseEnquiry(
      deps,
      parse({ mode: "update", enquiry_id: ENQ, stage_id: S1, status: "open" }),
      {
        contactId: CONTACT,
        channelId: null,
        target,
      },
    );
    expect(calls).toEqual([]);
    expect(r).toEqual({ enquiryId: ENQ, number: null, created: false, steps: [] });
  });

  it("stops at the first service error so the caller can leave the conversation open", async () => {
    const { deps, calls } = fakeDeps();
    deps.moveStage = async () => {
      throw new Error("stage gone");
    };
    await expect(
      applyCloseEnquiry(
        deps,
        parse({ mode: "update", enquiry_id: ENQ, stage_id: S2, status: "won" }),
        {
          contactId: CONTACT,
          channelId: null,
          target,
        },
      ),
    ).rejects.toThrow("stage gone");
    expect(calls).toEqual([]);
  });

  it("turns a date input into the stored ISO time", () => {
    expect(apptDateValue(undefined)).toBeUndefined();
    expect(apptDateValue("")).toBeNull();
    expect(apptDateValue("2026-11-02")).toBe("2026-11-02T00:00:00.000Z");
  });
});
