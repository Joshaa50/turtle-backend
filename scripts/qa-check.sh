#!/usr/bin/env bash
# Turtle Guard backend QA gate. Runs all checks, never stops early.
# Raw output for the qa-tester agent lands in qa-out/.
cd "$(dirname "$0")/.." || exit 2
mkdir -p qa-out
fail=0

echo "── syntax ────────────────────────────────"
node --check server.js > qa-out/syntax.txt 2>&1 \
  && echo "PASS" || { echo "FAIL"; cat qa-out/syntax.txt; fail=1; }

echo "── api tests ─────────────────────────────"
npx vitest run --reporter=json --outputFile=qa-out/vitest.json --reporter=dot > qa-out/vitest.txt 2>&1 \
  && echo "PASS" || { echo "FAIL"; grep -E "✕|×|FAIL|AssertionError|Error:" qa-out/vitest.txt | head -40; fail=1; }

echo "──────────────────────────────────────────"
[ $fail -eq 0 ] && echo "BACKEND GATE: PASS" || echo "BACKEND GATE: FAIL"
exit $fail
