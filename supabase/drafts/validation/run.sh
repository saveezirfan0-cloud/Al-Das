#!/usr/bin/env bash
# Apply the Phase 0 draft migrations to a scratch Postgres database and run the smoke tests.
# Usage: DATABASE_URL=postgres://... supabase/drafts/validation/run.sh
#        (defaults to a local cluster: postgres:///pulse_drafts_check)
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${DATABASE_URL:-pulse_drafts_check}"
PSQL="psql -v ON_ERROR_STOP=1 -X -q"

if [[ "$DB" != postgres* ]]; then
  dropdb --if-exists "$DB"
  createdb "$DB"
fi

$PSQL -d "$DB" -f validation/stubs_phase1_2_6.sql
for f in 0100_clinical_reference.sql 0101_clinical_settings.sql 0102_visits_prescriptions.sql \
         0103_clinical_followups.sql 0104_recall.sql 0105_appointment_reminders_ext.sql; do
  echo "applying $f"
  $PSQL -d "$DB" -f "$f"
done
# idempotency: applying twice must be a no-op
for f in 0100_clinical_reference.sql 0101_clinical_settings.sql 0102_visits_prescriptions.sql \
         0103_clinical_followups.sql 0104_recall.sql 0105_appointment_reminders_ext.sql; do
  $PSQL -d "$DB" -f "$f" >/dev/null
done
echo "re-apply OK"
$PSQL -d "$DB" -f validation/smoke_tests.sql
