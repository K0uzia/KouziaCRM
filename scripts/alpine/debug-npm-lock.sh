#!/usr/bin/env bash
# Diagnostic one-shot npm lockfile / Alpine (session debug 46af7e).
# Usage sur le CT: bash /opt/kouziacrm/scripts/alpine/debug-npm-lock.sh
set -euo pipefail
APP="${KOUZIA_APP_DIR:-/opt/kouziacrm}"
LOG="${APP}/.cursor/debug-46af7e.log"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

emit() {
  printf '{"sessionId":"46af7e","runId":"pre-fix","hypothesisId":"%s","location":"debug-npm-lock.sh","message":"%s","data":%s,"timestamp":%s}\n' \
    "$1" "$2" "$3" "$(date +%s%3N 2>/dev/null || date +%s000)" >> "$LOG"
}

cd "$APP"
emit "B" "versions" "{\"npm\":\"$(npm -v)\",\"node\":\"$(node -v)\",\"alpine\":\"$(cat /etc/alpine-release 2>/dev/null || echo n/a)\"}"

KEYS="$(node -e 'const l=require("./package-lock.json");console.log(JSON.stringify(Object.keys(l.packages||{}).filter(k=>k.includes("lightningcss"))))')"
MUSL="$(node -e 'const l=require("./package-lock.json");console.log(!!l.packages["node_modules/lightningcss-linux-x64-musl"])')"
GNU="$(node -e 'const l=require("./package-lock.json");console.log(!!l.packages["node_modules/lightningcss-linux-x64-gnu"])')"
emit "A" "lockfile_lightningcss" "{\"keys\":${KEYS},\"muslInLock\":${MUSL},\"gnuInLock\":${GNU}}"

LIBC="$(node -e 'try{console.log(require("detect-libc").familySync())}catch(e){console.log("no-detect-libc-yet")}' 2>/dev/null || echo unknown)"
emit "D" "runtime_platform" "{\"libc\":\"${LIBC}\",\"arch\":\"$(uname -m)\",\"platform\":\"$(uname -s)\"}"

set +e
npm ci 2> /tmp/kouzia-npm-ci.err > /tmp/kouzia-npm-ci.out
RC=$?
set -e
MISS="$(grep -E 'Missing:|EUSAGE|in sync' /tmp/kouzia-npm-ci.err /tmp/kouzia-npm-ci.out 2>/dev/null | head -30 | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')"
emit "A" "npm_ci_result" "{\"exitCode\":${RC},\"excerpt\":${MISS}}"
emit "C" "postinstall_reached" "{\"ok\":$([[ $RC -eq 0 ]] && echo true || echo false)}"
emit "E" "npm_major" "{\"npmMajor\":$(npm -v | cut -d. -f1)}"

echo "RC=$RC"
echo "Log écrit: $LOG"
cat "$LOG"
