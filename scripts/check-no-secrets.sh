#!/usr/bin/env bash
# Fail CI if a tracked file contains something that looks like a literal
# credential. This is a tripwire, not a scanner: the patterns are the exact
# shapes that have been committed to this repo (or its siblings) before —
# a shell `PASSWORD="…"`, a hex master secret, Google OAuth/API tokens, PEM
# blocks, and npm `_authToken=` lines.
#
# Only git-tracked files are examined, so .env files and node_modules never
# trip it. A hit that is intentionally public goes in
# scripts/check-no-secrets.allow with a reason; every entry there is
# `<path><TAB><extended-regex>` and only suppresses lines in that one file
# that match that regex.
#
# Same script as the control plane's scripts/check-no-secrets.sh, with one
# refinement: a `PASSWORD="$VAR"` / `_authToken=$(…)` / `_authToken=${…}`
# interpolation is not a literal (the deploy and demo scripts are full of
# them), so the `$`-prefixed forms are not matched. Anything literal after
# the `=` still is.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# `PASS(WORD)?="${VAR:-literal}"` — a shipped default IS a literal (the demo
# scripts defaulted DB_PASS to the live Cloud SQL password this way until
# 2026-10-03), so the `:-` fallback form is matched too.
PATTERN='PASS(WORD)?="[^$"]|PASS(WORD)?="\$\{[A-Z_]+:-[^}]|SECRET="[0-9a-fA-F]{16,}"|_KEY="[0-9a-fA-F]{32,}"|ya29\.|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|_authToken=[^$]'
ALLOW_FILE="scripts/check-no-secrets.allow"

# The allowlist and this script mention the patterns by name, so they are
# excluded from the scan rather than allowlisted line by line.
hits=$(git ls-files -z \
  | grep -zvE '^(scripts/check-no-secrets\.(sh|allow))$' \
  | xargs -0 grep -HnIE "$PATTERN" -- 2>/dev/null || true)

if [ -n "$hits" ] && [ -f "$ALLOW_FILE" ]; then
  while IFS=$'\t' read -r allow_path allow_regex; do
    [ -z "$allow_path" ] && continue
    case "$allow_path" in \#*) continue ;; esac
    hits=$(printf '%s\n' "$hits" | grep -vE "^${allow_path}:[0-9]+:.*(${allow_regex})" || true)
  done < "$ALLOW_FILE"
fi

if [ -n "$hits" ]; then
  echo "check-no-secrets: literal credential(s) found in tracked files:" >&2
  # Print path:line and the matched token shape only — never echo the full
  # line, or the secret ends up in CI logs as well as git.
  printf '%s\n' "$hits" | cut -d: -f1,2 | sed 's/^/  /' >&2
  echo >&2
  echo "Move the value to an environment variable / Secret Manager and remove it" >&2
  echo "from the tree. If it is genuinely public, add '<path>\t<regex>' with a" >&2
  echo "reason to ${ALLOW_FILE}." >&2
  exit 1
fi

echo "check-no-secrets: ok"
