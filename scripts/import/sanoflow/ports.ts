/**
 * What the Sanoflow importers need beyond the generic ImportStore: contact matching, members by
 * e-mail, reference lookups by name, segment memberships, the guarded appointment booking and the
 * review queue. SupabasePorts is the real implementation; DryRunPorts records "would write" on top
 * of a real store (reads still hit the database); tests implement the same interface in memory or
 * over raw pg.
 */
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { toCustomFieldDef } from "@/lib/contacts/defs";
import { matchContact, queueSyncReview } from "@/lib/contacts/import-writer";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

import { DryRunStore, SupabaseStore, type ImportStore } from "../store";

export type ContactMatch =
  | { kind: "match"; id: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: Array<{ contact_id: string; matched_on: string }> };

export type RefTable = "locations" | "specialists" | "services";
export type RefRow = {
  id: string;
  name: string;
  department_id: string | null;
  duration_min: number | null;
};

export type BookInput = {
  contactId: string;
  locationId: string;
  specialistId: string;
  serviceId: string | null;
  departmentId: string | null;
  startsAt: string;
  endsAt: string;
  status: "awaiting" | "confirmed";
  notes: string | null;
};

export interface SanoflowPorts extends ImportStore {
  /** Live contact id for a stored id, following merges; null when deleted. */
  liveContact(id: string): Promise<string | null>;
  matchContactByPhone(e164: string): Promise<ContactMatch>;
  /** Active member of the org with this e-mail (case-insensitive). */
  memberIdByEmail(email: string): Promise<string | null>;
  findByName(table: RefTable, name: string): Promise<RefRow | null>;
  hasSegmentMember(segmentId: string, contactId: string): Promise<boolean>;
  addSegmentMember(segmentId: string, contactId: string): Promise<{ error?: string }>;
  refreshSegmentCount(segmentId: string): Promise<void>;
  /** A live (not cancelled) appointment for this patient and specialist at this exact start. */
  findAppointment(m: {
    contactId: string;
    specialistId: string;
    startsAt: string;
  }): Promise<string | null>;
  /** public.book_appointment with the overlap check on; { error: "slot_taken" } when the slot is busy. */
  bookAppointment(b: BookInput): Promise<{ id: string } | { error: string }>;
  queueReview(r: {
    entity: string;
    externalId: string;
    reason: string;
    candidates?: Array<{ contact_id: string; matched_on: string }>;
  }): Promise<void>;
  /** Marks an open review for this row resolved (a later run settled it). */
  resolveReview(entity: string, externalId: string): Promise<void>;
  /** Custom field definitions of an entity, as stored. */
  customFieldDefs(entity: "contact" | "enquiry"): Promise<CustomFieldDef[]>;
  enquirySources(): Promise<string[]>;
  setEnquirySources(sources: string[]): Promise<{ error?: string }>;
}

export class SupabasePorts extends SupabaseStore implements SanoflowPorts {
  constructor(admin: AdminClient, orgId: string) {
    super(admin, orgId, "sanoflow");
  }

  async liveContact(id: string) {
    let cur: string | null = id;
    for (let hop = 0; cur && hop < 5; hop++) {
      const {
        data,
      }: { data: { id: string; deleted_at: string | null; merged_into_id: string | null } | null } =
        await this.db
          .from("contacts")
          .select("id, deleted_at, merged_into_id")
          .eq("org_id", this.orgId)
          .eq("id", cur)
          .maybeSingle();
      if (!data) return null;
      if (!data.deleted_at) return data.id;
      cur = data.merged_into_id;
    }
    return null;
  }

  async matchContactByPhone(e164: string): Promise<ContactMatch> {
    const m = await matchContact(this.admin, this.orgId, { phone: e164 });
    if (m.kind === "match") return { kind: "match", id: m.id };
    if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.candidates };
    return { kind: "none" };
  }

  async memberIdByEmail(email: string) {
    const { data } = await this.db
      .from("profiles")
      .select("id, memberships!inner(org_id, status)")
      .ilike("email", email.trim().replace(/[%_\\]/g, "\\$&"))
      .eq("memberships.org_id", this.orgId)
      .eq("memberships.status", "active")
      .limit(2);
    return data && data.length === 1 ? (data[0].id as string) : null;
  }

  async findByName(table: RefTable, name: string) {
    const cols =
      table === "services"
        ? "id, name, department_id, duration_min"
        : table === "specialists"
          ? "id, name, department_id"
          : "id, name";
    const { data } = await this.db
      .from(table)
      .select(cols)
      .eq("org_id", this.orgId)
      .ilike("name", name.trim().replace(/[%_\\]/g, "\\$&"))
      .limit(2);
    if (!data || data.length !== 1) return null;
    const r = data[0];
    return {
      id: r.id as string,
      name: r.name as string,
      department_id: (r.department_id as string | null) ?? null,
      duration_min: (r.duration_min as number | undefined) ?? null,
    };
  }

  async hasSegmentMember(segmentId: string, contactId: string) {
    const { data } = await this.db
      .from("segment_members")
      .select("contact_id")
      .eq("org_id", this.orgId)
      .eq("segment_id", segmentId)
      .eq("contact_id", contactId)
      .maybeSingle();
    return !!data;
  }

  async addSegmentMember(segmentId: string, contactId: string) {
    const { error } = await this.db
      .from("segment_members")
      .upsert(
        { org_id: this.orgId, segment_id: segmentId, contact_id: contactId },
        { onConflict: "segment_id,contact_id", ignoreDuplicates: true },
      );
    return error ? { error: `db ${error.code ?? "error"}` } : {};
  }

  async refreshSegmentCount(segmentId: string) {
    const { count } = await this.db
      .from("segment_members")
      .select("contact_id", { count: "exact", head: true })
      .eq("org_id", this.orgId)
      .eq("segment_id", segmentId);
    await this.db
      .from("segments")
      .update({ member_count: count ?? 0, count_refreshed_at: new Date().toISOString() })
      .eq("org_id", this.orgId)
      .eq("id", segmentId);
  }

  async findAppointment(m: { contactId: string; specialistId: string; startsAt: string }) {
    const { data } = await this.db
      .from("appointments")
      .select("id")
      .eq("org_id", this.orgId)
      .eq("contact_id", m.contactId)
      .eq("specialist_id", m.specialistId)
      .eq("starts_at", m.startsAt)
      .neq("status", "cancelled")
      .limit(1);
    return ((data as Array<{ id: string }> | null) ?? [])[0]?.id ?? null;
  }

  async bookAppointment(b: BookInput) {
    const { data, error } = await this.admin.rpc("book_appointment", {
      p_org_id: this.orgId,
      p_contact_id: b.contactId,
      p_location_id: b.locationId,
      p_specialist_id: b.specialistId,
      p_service_id: b.serviceId as string,
      p_department_id: b.departmentId as string,
      p_starts_at: b.startsAt,
      p_ends_at: b.endsAt,
      p_status: b.status,
      p_notes: b.notes as string,
      p_notify_early: false,
      p_source: "import",
      p_created_by: null as unknown as string,
      p_enforce: true,
    });
    if (error)
      return {
        error: error.message.includes("slot_taken") ? "slot_taken" : `db ${error.code ?? "error"}`,
      };
    const row = (Array.isArray(data) ? data[0] : data) as { id?: string } | null;
    return row?.id ? { id: row.id } : { error: "no row returned" };
  }

  async queueReview(r: {
    entity: string;
    externalId: string;
    reason: string;
    candidates?: Array<{ contact_id: string; matched_on: string }>;
  }) {
    await queueSyncReview(this.admin, {
      orgId: this.orgId,
      source: "sanoflow",
      entity: r.entity,
      externalId: r.externalId,
      reason: r.reason,
      candidates: r.candidates ?? [],
    });
  }

  async resolveReview(entity: string, externalId: string) {
    await this.db
      .from("sync_reviews")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("org_id", this.orgId)
      .eq("source", "sanoflow")
      .eq("entity", entity)
      .eq("external_id", externalId)
      .eq("status", "open");
  }

  async customFieldDefs(entity: "contact" | "enquiry") {
    const { data } = await this.db
      .from("custom_fields")
      .select("key, label, type, options, required")
      .eq("org_id", this.orgId)
      .eq("entity", entity)
      .order("sort");
    return ((data ?? []) as Parameters<typeof toCustomFieldDef>[0][]).map(toCustomFieldDef);
  }

  async enquirySources() {
    const { data } = await this.db
      .from("orgs")
      .select("settings")
      .eq("id", this.orgId)
      .maybeSingle();
    return readEnquirySettings(data?.settings).sources;
  }

  async setEnquirySources(sources: string[]) {
    const { data } = await this.db
      .from("orgs")
      .select("settings")
      .eq("id", this.orgId)
      .maybeSingle();
    const settings = (data?.settings ?? {}) as Record<string, Json>;
    const enquiries = (settings.enquiries ?? {}) as Record<string, Json>;
    const { error } = await this.db
      .from("orgs")
      .update({ settings: { ...settings, enquiries: { ...enquiries, sources } } })
      .eq("id", this.orgId);
    return error ? { error: `db ${error.code ?? "error"}` } : {};
  }
}

/**
 * Dry run: generic writes go to the DryRunStore overlay; reads of contacts, members and reference
 * data pass through. Bookings are predicted by the read-only overlap check plus the bookings this
 * run would already have made, so two rows for the same slot are reported as a conflict.
 */
export class DryRunPorts extends DryRunStore implements SanoflowPorts {
  private members = new Set<string>();
  private booked: Array<{
    specialistId: string;
    start: number;
    end: number;
    contactId: string;
    id: string;
  }> = [];
  private sources: string[] | null = null;
  constructor(
    private readonly real: SanoflowPorts,
    private readonly slotBusy: (b: BookInput) => Promise<boolean>,
  ) {
    super(real);
  }
  liveContact(id: string) {
    return id.startsWith("dry-") ? Promise.resolve(id) : this.real.liveContact(id);
  }
  matchContactByPhone(e164: string) {
    return this.real.matchContactByPhone(e164);
  }
  memberIdByEmail(email: string) {
    return this.real.memberIdByEmail(email);
  }
  findByName(table: RefTable, name: string) {
    return this.real.findByName(table, name);
  }
  async hasSegmentMember(segmentId: string, contactId: string) {
    if (this.members.has(`${segmentId}|${contactId}`)) return true;
    return segmentId.startsWith("dry-") ? false : this.real.hasSegmentMember(segmentId, contactId);
  }
  async addSegmentMember(segmentId: string, contactId: string) {
    this.members.add(`${segmentId}|${contactId}`);
    return {};
  }
  async refreshSegmentCount() {}
  async findAppointment(m: { contactId: string; specialistId: string; startsAt: string }) {
    const t = Date.parse(m.startsAt);
    const hit = this.booked.find(
      (b) => b.contactId === m.contactId && b.specialistId === m.specialistId && b.start === t,
    );
    return hit?.id ?? (await this.real.findAppointment(m));
  }
  async bookAppointment(b: BookInput) {
    const start = Date.parse(b.startsAt);
    const end = Date.parse(b.endsAt);
    const clash = this.booked.some(
      (x) => x.specialistId === b.specialistId && x.start < end && x.end > start,
    );
    if (clash || (await this.slotBusy(b))) return { error: "slot_taken" };
    const id = `dry-appointments-${this.booked.length + 1}`;
    this.booked.push({ specialistId: b.specialistId, start, end, contactId: b.contactId, id });
    return { id };
  }
  async queueReview() {}
  async resolveReview() {}
  customFieldDefs(entity: "contact" | "enquiry") {
    return this.real.customFieldDefs(entity);
  }
  async enquirySources() {
    return this.sources ?? (await this.real.enquirySources());
  }
  async setEnquirySources(sources: string[]) {
    this.sources = sources;
    return {};
  }
}

/** Read-only overlap check used by dry runs (mirrors app.assert_slot_free). */
export function supabaseSlotBusy(admin: AdminClient, orgId: string) {
  return async (b: BookInput): Promise<boolean> => {
    const [{ data: appts }, { data: blocks }] = await Promise.all([
      admin
        .from("appointments")
        .select("id")
        .eq("org_id", orgId)
        .eq("specialist_id", b.specialistId)
        .in("status", ["awaiting", "confirmed", "completed"])
        .lt("starts_at", b.endsAt)
        .gt("ends_at", b.startsAt)
        .limit(1),
      admin
        .from("time_blocks")
        .select("id, location_id")
        .eq("org_id", orgId)
        .eq("specialist_id", b.specialistId)
        .lt("starts_at", b.endsAt)
        .gt("ends_at", b.startsAt)
        .limit(20),
    ]);
    if (appts && appts.length) return true;
    return (blocks ?? []).some((x) => x.location_id === null || x.location_id === b.locationId);
  };
}
