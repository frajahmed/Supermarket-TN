#!/usr/bin/env bash
# =============================================================================
#  Gesamtprüfung Supermarket-TN – wird vor jeder Freigabe ausgeführt.
#
#  Aufruf:  bash scripts/test-all.sh
#
#  Datenbank-Tests brauchen einen PostgreSQL-Server (>= 15) mit Superuser-Zugang
#  über die üblichen Variablen PGHOST / PGPORT / PGUSER / PGPASSWORD.
#  Es wird eine Wegwerf-Datenbank $STN_TEST_DB (Standard: stn_test) neu angelegt.
#  Ohne erreichbaren Server werden die DB-Tests als ÜBERSPRUNGEN gemeldet
#  (bei der Abnahme durch Claude ist das ein Fehler: STN_REQUIRE_DB=1).
#
#  NestJS-Integrationstest läuft nur, wenn backend/node_modules existiert.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${STN_TEST_DB:-stn_test}"
PASS=0; FAIL=0; SKIP=0
RESULTS=()

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

record() {  # record <status> <name> [detail]
  case "$1" in
    ok)   PASS=$((PASS+1)); RESULTS+=("OK      $2"); green "✔ $2" ;;
    fail) FAIL=$((FAIL+1)); RESULTS+=("FEHLER  $2 ${3:-}"); red "✘ $2 ${3:-}" ;;
    skip) SKIP=$((SKIP+1)); RESULTS+=("SKIP    $2 ${3:-}"); yellow "○ $2 ${3:-}" ;;
  esac
}

run_step() {  # run_step <name> <command...>  – Ausgabe nur bei Fehler zeigen
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then record ok "$name"
  else record fail "$name"; echo "$out" | tail -40; fi
}

# ---------------------------------------------------------------------------
# 0. Voraussetzungen und Hausregeln
# ---------------------------------------------------------------------------
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 18 ]; }; then
  record ok "Node $(node -v) (>= 22.18)"
else
  record fail "Node >= 22.18 benötigt" "(gefunden: $(node -v 2>/dev/null || echo keins))"
fi

cd "$ROOT"
# Angewendete Migrationen dürfen sich nie ändern (Prüfsummen von Claude gepflegt)
if [ -f scripts/migration-checksums.txt ]; then
  if sha256sum --quiet -c scripts/migration-checksums.txt >/dev/null 2>&1; then
    record ok "Angewendete Migrationen unverändert"
  else
    record fail "Angewendete Migration wurde verändert" "(neue Datei db/NNN_… anlegen statt ändern)"
  fi
fi
# Keine Geheimnisse im Repo
if git ls-files 2>/dev/null | grep -Eq '\.(key|pem)$|(^|/)\.env$'; then
  record fail "Geheimnisse im Repo" "($(git ls-files | grep -E '\.(key|pem)$|(^|/)\.env$' | head -3 | tr '\n' ' '))"
else
  record ok "Keine Schlüssel/.env im Repo"
fi
# license-server und shared ohne Laufzeit-Abhängigkeiten
if node -e '
  const p=require("./license-server/package.json");
  process.exit(Object.keys(p.dependencies||{}).length===0?0:1)' 2>/dev/null; then
  record ok "Lizenzserver ohne externe Abhängigkeiten"
else
  record fail "Lizenzserver hat Laufzeit-Abhängigkeiten bekommen"
fi

# ---------------------------------------------------------------------------
# 1. TypeScript-Typprüfung (falls tsc verfügbar)
# ---------------------------------------------------------------------------
TSC=""
for c in "$ROOT/backend/node_modules/.bin/tsc" "$ROOT/license-server/node_modules/.bin/tsc" "$(command -v tsc 2>/dev/null)"; do
  [ -n "$c" ] && [ -x "$c" ] && { TSC="$c"; break; }
done
TYPEROOT_ARGS=()
# @types/node: Projekt, global oder neben dem gefundenen tsc (z. B. .../node_modules/.bin/tsc -> .../node_modules/@types)
TSC_TYPES="$( [ -n "$TSC" ] && cd "$(dirname "$(readlink -f "$TSC")")/../.." 2>/dev/null && pwd)/@types"
for d in "$ROOT/backend/node_modules/@types" "$ROOT/license-server/node_modules/@types" "$(npm root -g 2>/dev/null)/@types" "$TSC_TYPES" "$(dirname "$(dirname "$TSC")")/@types"; do
  [ -d "$d/node" ] && { TYPEROOT_ARGS=(--typeRoots "$d"); break; }
done
if [ -n "$TSC" ]; then
  run_step "Typprüfung Lizenzserver" "$TSC" -p license-server/tsconfig.json "${TYPEROOT_ARGS[@]}"
  run_step "Typprüfung Backend-Kern" "$TSC" -p backend/tsconfig.core.json "${TYPEROOT_ARGS[@]}"
  if [ -d backend/node_modules/@nestjs ]; then
    run_step "Typprüfung Backend (NestJS)" "$TSC" -p backend/tsconfig.json --noEmit
  else
    record skip "Typprüfung Backend (NestJS)" "(npm install in backend/ fehlt)"
  fi
  # App (Expo): Bildschirme und Laufzeitcode – die Logik-Tests allein prüfen das nicht
  if [ -d app/node_modules/expo ] && [ -x app/node_modules/.bin/tsc ]; then
    run_step "Typprüfung App (Expo)" app/node_modules/.bin/tsc -p app/tsconfig.json --noEmit
  else
    record skip "Typprüfung App (Expo)" "(npm install in app/ fehlt)"
  fi
else
  record skip "Typprüfung" "(tsc nicht gefunden – npm i -g typescript)"
fi

# ---------------------------------------------------------------------------
# 2. Node-Tests (laufen ohne npm install)
# ---------------------------------------------------------------------------
node_tests() {  # node_tests <name> <dir> <glob>
  local out
  out="$(cd "$ROOT/$2" && node --test "$3" 2>&1)"
  local pass fail
  pass=$(echo "$out" | sed -n 's/^[#ℹ] pass \([0-9]*\)/\1/p' | tail -1)
  fail=$(echo "$out" | sed -n 's/^[#ℹ] fail \([0-9]*\)/\1/p' | tail -1)
  if [ "${fail:-1}" = "0" ] && [ "${pass:-0}" -gt 0 ]; then record ok "$1 ($pass Tests)"
  else record fail "$1" "(bestanden ${pass:-0}, fehlgeschlagen ${fail:-?})"
    # Details je fehlgeschlagenem Test: Meldung, erwartet/tatsächlich, Stelle im Code
    echo "$out" | awk '/^not ok/{show=1; n=0} show{print; n++} /^ok /{show=0} n>45{show=0}' | head -120; fi
}
node_tests "Lizenzserver-Tests" license-server "test/**/*.test.ts"
node_tests "Lizenz- und Login-Tests (Kern)" backend "test-core/**/*.test.ts"
node_tests "Expo-App-Tests" app "test/**/*.test.ts"

# ---------------------------------------------------------------------------
# 3. Datenbank: Migrationen auf frische DB + SQL-Tests
# ---------------------------------------------------------------------------
if command -v psql >/dev/null && psql -d postgres -tAc 'select 1' >/dev/null 2>&1; then
  psql -d postgres -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
  MIG_OK=1
  for f in db/[0-9]*.sql; do
    if ! out="$(psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1)"; then
      record fail "Migration $(basename "$f")"; echo "$out" | tail -10; MIG_OK=0; break
    fi
  done
  if [ $MIG_OK = 1 ]; then
    record ok "Migrationen auf frischer Datenbank ($(ls db/[0-9]*.sql | wc -l) Dateien)"
    for t in db/tests/*.sql; do
      out="$(psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$t" 2>&1)"
      n=$(echo "$out" | grep -c ' ok:')
      if echo "$out" | grep -q 'BESTANDEN' && ! echo "$out" | grep -qE 'FAIL|ERROR'; then
        record ok "SQL $(basename "$t") ($n Prüfungen)"
      else
        record fail "SQL $(basename "$t")"; echo "$out" | grep -E 'FAIL|ERROR' | head -5
      fi
    done
  fi
  # NestJS-Integrationstest gegen dieselbe frische DB
  if [ -d backend/node_modules/@nestjs ] && [ $MIG_OK = 1 ]; then
    psql -d "$DB" -q -c "ALTER ROLE app_user LOGIN PASSWORD 'stn_test_pw'" >/dev/null
    export DATABASE_URL="postgres://app_user:stn_test_pw@${PGHOST:-localhost}:${PGPORT:-5432}/$DB"
    export ADMIN_DATABASE_URL="postgres://${PGUSER:-postgres}${PGPASSWORD:+:$PGPASSWORD}@${PGHOST:-localhost}:${PGPORT:-5432}/$DB"
    run_step "NestJS-Build" bash -c "cd backend && npm run -s build"
    node_tests "NestJS-Integrationstest" backend "dist/backend/src/test/**/*.test.js"
  else
    record skip "NestJS-Integrationstest" "(npm install in backend/ fehlt)"
  fi
else
  if [ "${STN_REQUIRE_DB:-0}" = "1" ]; then record fail "Datenbank-Tests" "(kein PostgreSQL erreichbar)"
  else record skip "Datenbank-Tests" "(kein PostgreSQL erreichbar – PGHOST/PGPORT/PGUSER setzen)"; fi
fi

# ---------------------------------------------------------------------------
# Zusammenfassung
# ---------------------------------------------------------------------------
echo
echo "================ Zusammenfassung ================"
printf '%s\n' "${RESULTS[@]}"
echo "-------------------------------------------------"
echo "bestanden: $PASS   fehlgeschlagen: $FAIL   übersprungen: $SKIP"
if [ $FAIL -eq 0 ]; then green "ALLE PRÜFUNGEN BESTANDEN"; exit 0
else red "PRÜFUNG FEHLGESCHLAGEN"; exit 1; fi
