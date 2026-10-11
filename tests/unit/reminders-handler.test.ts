import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { handleScheduled, scheduledEnvelope } from "@/lib/jobs/handlers/reminders";
import { PermanentJobError } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
// None of these paths may touch the database.
const noDb = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as unknown as AdminClient;

describe("scheduled reminder envelope", () => {
  it("parses the scheduler's queue message", () => {
    const parsed = scheduledEnvelope.safeParse({
      kind: "task.due",
      org_id: ORG,
      scheduled_job_id: "j1",
      attempt: 1,
      payload: { task_id: ID, due_at: "2026-10-09T10:00:00Z" },
    });
    expect(parsed.success).toBe(true);
  });

  it("does not claim ordinary notification jobs", () => {
    expect(scheduledEnvelope.safeParse({ type: "email", to: "a@b.co", subject: "s", text: "t" }).success).toBe(false);
  });

  it("dead-letters malformed jobs instead of retrying them", async () => {
    const env = (kind: string, payload: Record<string, unknown>, org: string | null = ORG) =>
      ({ kind, org_id: org, scheduled_job_id: "j", payload }) as never;
    await expect(handleScheduled(env("task.due", {}), noDb)).rejects.toBeInstanceOf(PermanentJobError);
    await expect(handleScheduled(env("enquiry.sla", { enquiry_id: "nope" }), noDb)).rejects.toBeInstanceOf(PermanentJobError);
    await expect(handleScheduled(env("something.else", {}), noDb)).rejects.toBeInstanceOf(PermanentJobError);
    await expect(handleScheduled(env("task.due", { task_id: ID, due_at: "x" }, null), noDb)).rejects.toBeInstanceOf(PermanentJobError);
  });
});
