#!/usr/bin/env bash
# Prepares a plain-Postgres test database for `pnpm test:db`.
#   - creates the database named in TEST_DATABASE_URL (drops it first)
#   - installs the pgmq/pg_cron/pg_net stand-ins into the server's extension dir (if writable)
#   - applies supabase/test/auth-stub.sql and every migration in order
#
# Usage: TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/pulse_test bash scripts/test-db.sh
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${TEST_DATABASE_URL%%\?*}"
DB="${URL##*/}"
BASE="${URL%/*}"
MAINT="$BASE/postgres"

# Extension stand-ins (pgmq is the real SQL-only extension; pg_cron/pg_net are stubs).
SHAREDIR="$(pg_config --sharedir 2>/dev/null || true)"
if [ -n "$SHAREDIR" ] && [ -w "$SHAREDIR/extension" ]; then
  if [ ! -f "$SHAREDIR/extension/pgmq.control" ]; then
    if [ -f "$ROOT/supabase/test/ext-stubs/pgmq--1.5.1.sql" ]; then
      cp "$ROOT/supabase/test/ext-stubs/pgmq.control" "$ROOT/supabase/test/ext-stubs/pgmq--1.5.1.sql" "$SHAREDIR/extension/"
    else
      echo "pgmq extension not installed and supabase/test/ext-stubs/pgmq--1.5.1.sql missing." >&2
      echo "Download it: curl -L -o supabase/test/ext-stubs/pgmq--1.5.1.sql https://raw.githubusercontent.com/pgmq/pgmq/v1.5.1/pgmq-extension/sql/pgmq.sql" >&2
      exit 1
    fi
  fi
  cp "$ROOT"/supabase/test/ext-stubs/pg_cron.control "$ROOT"/supabase/test/ext-stubs/pg_cron--*.sql \
     "$ROOT"/supabase/test/ext-stubs/pg_net.control "$ROOT"/supabase/test/ext-stubs/pg_net--*.sql "$SHAREDIR/extension/" 2>/dev/null || true
fi

# pgvector is required from Phase 10 (kb_chunks.embedding). It is a compiled extension, so it cannot be
# stubbed: install it into the test Postgres first (e.g. apt install postgresql-<ver>-pgvector).
if [ -n "$SHAREDIR" ] && [ ! -f "$SHAREDIR/extension/vector.control" ]; then
  echo "pgvector is not installed in this Postgres (missing $SHAREDIR/extension/vector.control)." >&2
  echo "Install it, e.g.: sudo apt-get install postgresql-$(pg_config --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')-pgvector" >&2
  exit 1
fi

psql "$MAINT" -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$DB\"" -c "create database \"$DB\""
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/test/auth-stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
done
echo "test database ready: $DB"
