# Reports inventory (Phase 0)

The third Phase 0 inventory required by docs/02 §6: every report or dashboard management and staff use today, where its numbers come from, and the metric that reproduces it in Phase 10. Sources: the Airtable interface pages read live on 8 Oct 2026 (Campaigns base; the Unite and Acute bases have no interfaces), the Sanoflow report list from docs/01 §3.10, and the Make-era logs. **The "centralised reporting Data Requirements Matrix" mentioned in docs/02 §6 was not found in the repo or the bases** (OQ-44).

Metric names below are the SQL views / materialized views the Phase 10 metrics layer will expose; the ones already drafted are marked ✅ (`supabase/drafts`).

## 1. Airtable interfaces in use (Campaigns – Message Log base)

### 1.1 Patient Messaging → "Patient Messaging Overview" (dashboard)
| Element | Today (Airtable) | Pulse metric |
|---|---|---|
| Total appointment messages sent | row count of Appointment Messages | `v_appointment_reminder_stats` ✅ (sum reminders_sent) |
| Total birthday messages sent (×2 tiles) | row count of Appointment Messages (mislabelled) and Birthday Messages | `v_recall_weekly` ✅ programme `birthday` |
| Messages sent in last 7 days | row count filtered by Message Sent On | `v_appointment_reminder_stats` by `sent_day` |
| Messages sent over time (line, daily) | Message Sent On | same, daily bucket |
| Messages by appointment status (bar) | Appointment Status code | `appointments.external_status` via `unite_appointment_status_map` ✅ (needs OQ-23) |
| Pivot: Status × Appointment Status | Appointment / Birthday × status code | reminders vs recall sends by status |
| Unique patients who received birthday messages | countUnique(Patient Name) | `count(distinct contact_id)` in `v_recall_weekly` ✅ |
| Birthday messages per month (line) | Message Sent On, month | `v_recall_weekly` rolled to month |
| Birthday count by age group (bar) | Age | `recall_sends.segment_key` ✅ |
| Birthday messages sent detail (list) | log rows | portal list on `recall_sends` (programme birthday) |

### 1.2 Today's Actions → "Today's Appointment Message Actions" (list)
Appointment Messages rows for today, with an embedded create form. → Pulse: Appointments page filtered to today with reminder status column; failed reminders become tasks (make-replacement-design §2).

### 1.3 Doctor & Department Performance (dashboard)
| Element | Today | Pulse metric |
|---|---|---|
| Total messages sent | row count | `v_appointment_reminder_stats` ✅ |
| % of patients contacted (with phone number) | percentFilled(Phone) | `patients_contacted / appointments` per period (new `mv_appointments_daily`) |
| "No-show rate per doctor and department" | percentFilled(Appointment Status) — **does not measure no-show** | true no-show rate = `external_status` mapped to no_show / appointments, per `specialist_id` and `location_id` (needs OQ-23) |
| Messages sent per doctor (bar) | Doctor Name | by `specialist_id` ✅ |
| % patients contacted per department | by Doctor Name (mislabelled "department") | by `specialists.department_id` |
| Pivot: messages, % contacted, no-show by doctor × clinic | Doctor Name × Clinic ID | `v_appointment_reminder_stats` × `locations` ✅ |
| Appointment & messaging activity overview (list) | log rows | Appointments table view with reminder columns |

### 1.4 Birthday Campaign Tracking → "Birthday Campaign Inbox" (list)
Birthday Messages rows with a create form. → `recall_sends` list, programme birthday, with reply/outcome columns.

### 1.5 Chronic Recall Tracking → "Chronic Recall Performance v2" (dashboard)
| Element | Today | Pulse metric |
|---|---|---|
| Live recalls sent | rows, Send Mode = Live | `v_recall_weekly.sent` ✅ (send_mode live) |
| Unique patients reached | countUnique(Patient Pin) | `unique_contacts` ✅ |
| Reply rate | percentFilled(Reply Date) | `replied / sent` ✅ |
| Booking rate (**target 30%**) and bookings confirmed | percentFilled / count(Booking Date) | `booked / sent` ✅ (attribution window OQ-33) |
| Avg days since last visit (target ~90; 85 vs 90 to confirm) | average(Days Since Last Visit) | `avg_days_since_last_visit` ✅ |
| Delivery outcome (donut Sent/Failed) | Send Status | `sent` vs `failed` ✅; later `messages.status` |
| Recall volume by condition (bar) | Condition | group by `segment_key` |
| Sends over time (daily) / per week (Week Starting) | Message Sent On | `v_recall_weekly` ✅ |
| Conversion funnel by condition (pivot Condition × Appointment Booked) | — | `segment_key` × `booked_at is not null` |
| Patients due a call now / longest wait / call list (longest wait first) | Follow-Up Due, Days Since Message Sent | `v_recall_call_list` ✅ (`call_now`, `days_waiting`) |
| Patients caught over 120 days / avg days – over-120 cohort / worst case | Recall Overdue Flag | `over_threshold` ✅, `max(days_since_last_visit_at_send)` |
| Overdue recalls to review (grid) | — | call-list view filtered `overdue` ✅ |
| Failed sends / failures by condition / failed rows to fix | Send Status = Failed | Failed Messages log + `status = failed` by `segment_key` |
| All rows logged; Send mode vs send status (pivot) | Test + Live | `v_recall_weekly` by `send_mode` ✅ |
| Template IDs in use; template coverage by condition (pivot) | Template ID | `recall_programme_templates` ✅ (no default row = gap visible) |
| Booking rate / reply rate (filtered by Send Mode) | — | same views filtered |

### 1.6 Views used as reports (Unite base, grid views)
`Chronic` (eligibility list the Make scenario reads), `Z00`, `2024`, `2025`, `Vitamin D`. The last four are ad-hoc filters whose purpose is unknown (OQ-45). Acute base: "Data Quality Exceptions" and "Unclassified Medications" are referenced in field descriptions → `v_visit_data_quality` ✅, `v_unclassified_medications` ✅.

## 2. Sanoflow reports in use (docs/01 §3.10) → Phase 10

| Sanoflow report | Pulse metric / page |
|---|---|
| Conversations Dashboard (all / unique / returning / open / closed; by channel per day) | `mv_daily_conversations` |
| Agent Performance Dashboard; Response Performance; Agent Performance | `mv_agent_performance` (first response, resolution time, closed per agent) |
| Conversation Analytics / Matrix / Heatmap | `mv_daily_conversations` by hour × weekday |
| Enquiries Dashboard; Enquiry Analytics; Stage Heatmap; Avg Time per Stage; Funnel; Closing vs Creation; Cohort; Enquiry → Appointment conversion | `mv_enquiry_stage_times`, `mv_enquiry_funnel` |
| Appointments Dashboard; Appointment Analytics; Online Appointments by Status | `mv_appointments_by_status` (+ location/specialist/no-show) |
| Click-to-Chat Ads Dashboard; Meta Ads Insights | Phase 2 (Marketing API) |
| WhatsApp Account Usage | `mv_wa_usage` from `messages` + Meta pricing analytics |
| User Logs / User Status Logs | `audit_log`, `memberships.presence_at` history |
| WhatsApp Flows report | Phase 2 |
| AI Agent Dashboard | Phase 10 AI usage from `kb_feedback` / AI calls |
| ROI Report | enquiries est_value × won, campaign cost |

## 3. Management dashboard (docs/02 §6) — data sources

| KPI | Source tables | Status |
|---|---|---|
| Enquiries in / closed / converted; conversion to appointments | `enquiries`, `appointments` | Phase 5/10 |
| Appointments by status / location / specialist; no-shows | `appointments` (+ Unite status map) | Phase 6/10, OQ-23 |
| Response times | `messages`, `conversations` | Phase 3/10 |
| Campaign results | `campaigns`, `campaign_recipients` | Phase 7/10 |
| Recall programme performance (chronic, birthday, screenings) | `recall_sends` ✅ | Phase 8 |
| Clinical follow-up load (queue size by category, overdue, red flags) | `clinical_followups` ✅, `clinical_feedback` ✅ | Phase 6 |
| Data quality (unmatched patients, incomplete vitals, unclassified drugs) | `v_visit_data_quality` ✅, `v_unclassified_medications` ✅ | Phase 6 |
| WhatsApp usage / cost | `messages` + Meta pricing analytics | Phase 10 |

## 4. Open items
- OQ-44: locate the Data Requirements Matrix (centralised reporting) so Phase 10 builds what management actually asked for.
- OQ-45: purpose of the Unite grid views `Z00`, `2024`, `2025`, `Vitamin D`.
- OQ-23: Unite appointment status codes, without which no-show reporting is impossible.
- The Airtable "no-show rate" tile measures field fill rate, not no-shows; management should be told the historical number was wrong before the new dashboard shows a different one.

## 5. As built in Phase 10 (`docs/08_PHASE_10_NOTES.md`)

### 5.1 Live reports and their metric definitions

OQ-44 (the Data Requirements Matrix) is still missing, so these are **working definitions**. Confirm them with management and change them in one place (`supabase/migrations/…001200_metrics.sql`).

| Metric | Definition |
|---|---|
| Day | Calendar day in the organisation's timezone (`orgs.timezone`, default Asia/Dubai). Periods, presets and the heatmap all use it. |
| Conversation opened | `conversations.opened_at`. A closed conversation that reopens on a new patient message keeps one row, so "opened" counts the first open, not every reopen. |
| First response | The first outbound message **sent by a staff member** (`messages.sent_by_user_id` set; bots, flows and automated templates excluded) at or after the conversation's first patient message. Conversations that started with an outbound message have no first-response time. |
| Resolution time | `closed_at − opened_at`, for closed conversations. |
| Returning contact | The contact had an earlier conversation than this one. Unique contacts = distinct contacts with a conversation opened in the period. |
| Answered by staff | Conversations with a first response ÷ conversations opened in the period. "Waiting for a staff reply" = a patient message and no staff reply yet. |
| SLA breach (live) | Open conversation whose last message is from the patient and older than `orgs.settings.reports.sla_minutes` (default 15). |
| Agent figures | Sums and counts per staff member per day, re-aggregated over the period, so averages are exact. A first reply is credited to whoever sent it; a closure to `closed_by`. |
| Usage | Outbound messages by day, template vs free-form, and delivery status. **Cost is not included** (no pricing data yet). |

Filter applicability: **channel** (WhatsApp number) — conversation, response, usage and the heatmap; **team** — conversation-level numbers (`assignee_team_id`) and the agent report (members of the team); **staff member** — the agent report. Daily message volume has no team dimension; the page says so when a team filter is active.

Materialized views refresh every 15 minutes (`pulse:metrics_refresh`), so dashboards can be up to 15 minutes behind; the Team lead dashboard reads live views and is current.

### 5.1a Appointment reports (live since the Phase 6 merge)

`v_appointment_facts` (a `security_invoker` view, service role only) is the contract: `id, org_id, day, status, source, location_id, location_name, specialist_id, specialist_name, external_status`, where `day` is the appointment's date in the org timezone (the day it takes place, not the day it was booked). Both reports read it through the `report_appointments_*` and `report_unite_*` functions (migration `20261009001400`).

- **No-show rate** = no-shows ÷ (completed + no-shows). Cancelled, awaiting and confirmed are outside the base, so a clinic with no outcomes yet shows "—", not 0%. The old Airtable "No-show rate per doctor" tile measured field fill rate (OQ-54); this is the replacement and will differ from it.
- **Unite status codes (OQ-23).** `appointments.status` follows `unite_appointment_status_map`. A code whose mapping is still empty leaves the appointment at *Awaiting*, so Unite no-shows and cancellations are undercounted until Settings → Unite EMR is filled in. The Unite report lists every raw code with its current mapping and the count of appointments still unmapped, so the gap is visible rather than silent.
- No location/specialist filter yet: both are breakdowns inside the report. A shared location filter needs the filter bar and export route extended.

### 5.2 Data contract for the awaiting reports

A report goes live when its source view exists with these columns and a `run` function is added to `lib/reports/registry.ts`. Days are org-timezone dates; every view carries `org_id`; materialized views follow the same access rules as the Phase 10 ones (revoked from API roles, read through a service-role function).

| Report | View | Columns (minimum) | Delivered by |
|---|---|---|---|
| Enquiry funnel | `mv_enquiry_funnel` | `org_id, day, pipeline_id, stage_id, entered, left, won, lost, disqualified, assignee_user_id, team_id` | Phase 5 (needs an enquiry stage-history table; the plan's §3 has none) |
| Time in stage | `mv_enquiry_stage_times` | `org_id, day, pipeline_id, stage_id, enquiries, seconds_sum` (sum + count, so averages re-aggregate) | Phase 5 |
| Campaign performance | `mv_campaign_funnel` | `org_id, campaign_id, channel_id, sent, delivered, read, replied, failed` | Phase 7 |
| WhatsApp cost | `mv_wa_usage` | `org_id, day, channel_id, category, country, messages, cost` from Meta `pricing_analytics` | a pricing-ingestion task (new) |

Management dashboard widgets that wait on these: enquiries in/closed/converted, conversion to appointments, appointments by status/location/specialist, no-shows, campaign results, WhatsApp cost.
