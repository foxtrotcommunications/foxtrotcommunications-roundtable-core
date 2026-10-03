#!/usr/bin/env bash
# Fail CI if a second list of platform action names appears in source.
#
# The action vocabulary (`intent_execute`, `discover`, `message`, `delegate`,
# `tool_call`, …) lives in ONE file per repo — core server/vocab/actions.ts,
# control plane api/services/actions.ts — kept byte-identical and pinned by
# tests/fixtures/actions.sha256. Before this existed the list was written out
# in six places and they drifted. This tripwire catches the seventh.
#
# Rule: a source line that quotes TWO OR MORE distinct known action names is
# "a list of actions" and must come from the vocabulary file instead. A single
# literal (`case 'tool_call':`, `=== 'delegate'`) is a use, not a definition,
# and is not flagged. Only git-tracked *.ts/*.tsx/*.js/*.mjs files are
# scanned; tests, fixtures and the vocabulary file itself are skipped.
#
# The known names are parsed out of the vocabulary file, so this script is
# not another copy of the list. Files that legitimately still carry a list
# (today: the ones another in-flight branch owns) go in
# scripts/check-action-literals.allow, one path (or directory prefix) per
# line with a reason — every entry is a follow-up, not a permanent exemption.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

VOCAB=""
for candidate in server/vocab/actions.ts api/services/actions.ts; do
  [ -f "$candidate" ] && VOCAB="$candidate" && break
done
if [ -z "$VOCAB" ]; then
  echo "check-action-literals: vocabulary file not found" >&2
  exit 1
fi
ALLOW_FILE="scripts/check-action-literals.allow"

# Known names: every quoted token on the five `export const *_ACTIONS/INTENT_OPS = [...] as const` lines.
names=$(grep -E '^export const (TRANSPORT_ACTIONS|MESSAGE_ACTIONS|INTENT_OPS|A2A_ACTIONS|MCP_ACTIONS) = \[' "$VOCAB" \
  | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u)
if [ -z "$names" ]; then
  echo "check-action-literals: could not parse names from $VOCAB" >&2
  exit 1
fi
ALT=$(printf '%s\n' "$names" | paste -sd'|' -)
LIT="['\"](${ALT})['\"]"

is_allowed() {
  local f="$1"
  [ -f "$ALLOW_FILE" ] || return 1
  while IFS= read -r allow_path; do
    [ -z "$allow_path" ] && continue
    case "$allow_path" in \#*) continue ;; esac
    allow_path="${allow_path%%[[:space:]]*}"
    case "$f" in "$allow_path"|"$allow_path"*) return 0 ;; esac
  done < "$ALLOW_FILE"
  return 1
}

fails=0
while IFS= read -r -d '' f; do
  case "$f" in
    "$VOCAB"|*/node_modules/*|node_modules/*|*/tests/*|tests/*|*/__tests__/*|*.test.ts|*.test.js|*.spec.ts|*/fixtures/*|*.d.ts|*/dist/*|dist/*|coverage/*) continue ;;
  esac
  is_allowed "$f" && continue
  # Candidate lines first (cheap), then count distinct known names per line.
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    line_no="${hit%%:*}"; text="${hit#*:}"
    n=$(printf '%s' "$text" | grep -oE "$LIT" | tr -d "'\"" | sort -u | wc -l | tr -d ' ')
    if [ "$n" -ge 2 ]; then
      printf '  %s:%s: %s\n' "$f" "$line_no" "$(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-120)" >&2
      fails=$((fails+1))
    fi
  done < <(grep -nE "$LIT" -- "$f" 2>/dev/null || true)
done < <(git ls-files -z -- '*.ts' '*.tsx' '*.js' '*.mjs')

if [ "$fails" -gt 0 ]; then
  echo >&2
  echo "check-action-literals: $fails line(s) define a list of platform actions outside $VOCAB." >&2
  echo "Import the names (ACTION.x, TRANSPORT_ACTIONS, INTENT_OPS, …) from the vocabulary" >&2
  echo "instead. If the file cannot change yet, add its path with a reason to $ALLOW_FILE." >&2
  exit 1
fi

echo "check-action-literals: ok (vocabulary: $VOCAB, $(printf '%s\n' "$names" | wc -l | tr -d ' ') names)"
