#!/bin/bash
# Aggregate every machine/test-*.mjs file into one pass/fail total.
# Some suites use node:test (TAP-ish "# pass N") and some print their own
# "N/N ... passed" line; handle both so the reported total is real.
cd "$(dirname "$0")/.." || exit 1
TOTAL=0; FAILED=0; FILES=0; BAD=""
for f in machine/test-*.mjs; do
  FILES=$((FILES+1))
  out=$(node "$f" 2>&1); code=$?
  # node:test prints its summary as "ℹ pass N" / "ℹ fail N". Anchor on that so a
  # test NAME containing the word "pass" cannot be mistaken for the count.
  p=$(printf '%s\n' "$out" | grep -E '^[^a-zA-Z0-9]* ?pass [0-9]+$' | grep -oE '[0-9]+$' | head -1)
  fl=$(printf '%s\n' "$out" | grep -E '^[^a-zA-Z0-9]* ?fail [0-9]+$' | grep -oE '[0-9]+$' | head -1)
  # Suites that predate node:test print their own "N/N ... passed" line instead.
  if [ -z "$p" ]; then
    p=$(printf '%s\n' "$out" | grep -oE '[0-9]+/[0-9]+ [^/]*passed' | head -1 | cut -d/ -f1)
  fi
  [ -z "$p" ] && p=1
  [ -z "$fl" ] && fl=0
  if [ "$code" -ne 0 ] && [ "$fl" -eq 0 ]; then fl=1; p=0; fi
  TOTAL=$((TOTAL+p)); FAILED=$((FAILED+fl))
  if [ "$code" -ne 0 ]; then
    BAD="$BAD $f"
    printf '%-48s FAIL (%s pass, %s fail)\n' "$f" "$p" "$fl"
  else
    printf '%-48s ok   (%s)\n' "$f" "$p"
  fi
done
echo "--------------------------------------------------------"
echo "files=$FILES  pass=$TOTAL  fail=$FAILED"
[ -n "$BAD" ] && echo "failing files:$BAD"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
