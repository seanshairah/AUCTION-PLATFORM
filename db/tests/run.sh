#!/usr/bin/env bash
# Loads the schema and seed into a fresh database and runs the invariant tests.
# Usage: db/tests/run.sh   (PG* environment variables select the server)
set -euo pipefail

DB="${TEST_DB:-abc_schema_test}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

dropdb --if-exists "$DB"
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT

psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/db/schema.sql"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/db/seed.sql"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/db/tests/invariants.sql"
