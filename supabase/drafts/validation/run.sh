#!/usr/bin/env bash
# Apply the Phase 0 draft migrations on top of the REAL Phase 1 migrations (tenancy, helpers, jobs)
# in a scratch Postgres database, then run the smoke tests.
#   - supabase/test/auth-stub.sql       Supabase roles / auth schema stand-in (never on a real project)
#   - migrations 0100 extensions, 0200 tenancy, 0300 jobs   (0400–0600 need pgmq/pg_cron and are not required here)
#   - validation/stubs_phase2_6.sql     minimal contacts/locations/specialists/messages/wa_templates/appointments
#   - drafts 0100–0105, applied twice (idempotency)
#   - validation/smoke_tests.sql
# Usage: supabase/drafts/validation/run.sh            (local cluster, db pulse_drafts_check)
#        DATABASE_URL=postgres://... supabase/drafts/validation/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/supabase/drafts"
DB="${DATABASE_URL:-pulse_drafts_check}"
PSQL="psql -v ON_ERROR_STOP=1 -X -q"

if [[ "$DB" != postgres* ]]; then
  dropdb --if-exists "$DB"
  createdb "$DB"
fi

$PSQL -d "$DB" -f "$ROOT/supabase/test/auth-stub.sql"
for f in 20261008000100_extensions_and_helpers.sql 20261008000200_tenancy.sql 20261008000300_jobs.sql; do
  echo "applying Phase 1 $f"
  $PSQL -d "$DB" -f "$ROOT/supabase/migrations/$f" >/dev/null
done
$PSQL -d "$DB" -f validation/stubs_phase2_6.sql

DRAFTS="0100_clinical_reference.sql 0101_clinical_settings.sql 0102_visits_prescriptions.sql 0103_clinical_followups.sql 0104_recall.sql 0105_appointment_reminders_ext.sql"
for f in $DRAFTS; do
  echo "applying draft $f"
  $PSQL -d "$DB" -f "$f" >/dev/null
done
for f in $DRAFTS; do
  $PSQL -d "$DB" -f "$f" >/dev/null
done
echo "re-apply OK"
$PSQL -d "$DB" -f validation/smoke_tests.sql
