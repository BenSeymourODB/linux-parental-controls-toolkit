#!/usr/bin/env bash
#
# set-roadmap-dates.sh
#
# Assigns "Start date" / "End date" on the GitHub Project
# (users/BenSeymourODB/projects/2) for the Phase-1 roadmap issues,
# spaced over 2026-06-16 .. 2026-07-12 in dependency order.
#
# This exists because the Claude Code GitHub MCP tools cannot edit
# Projects v2 fields; run it locally with the gh CLI instead.
#
# Prerequisites:
#   - gh CLI installed and authed
#   - project scopes:  gh auth refresh -s project,read:project
#   - jq installed
#
# Usage:  ./scripts/set-roadmap-dates.sh
#
set -euo pipefail

# Preflight: required tooling must be on PATH (friendlier than a set -e abort).
for bin in gh jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Required command '$bin' not found on PATH." >&2; exit 1; }
done

OWNER="BenSeymourODB"
PROJECT_NUMBER=2

# Adjust these if your project's date fields are named differently
# (e.g. GitHub's built-in roadmap layout often uses "Start date" / "Target date").
START_FIELD="Start date"
END_FIELD="End date"

# issue-number <TAB> start-date <TAB> end-date  (YYYY-MM-DD)
read -r -d '' SCHEDULE <<'EOF' || true
17	2026-06-16	2026-06-17
5	2026-06-16	2026-06-19
10	2026-06-17	2026-06-20
9	2026-06-20	2026-06-22
13	2026-06-20	2026-06-24
16	2026-06-22	2026-06-23
20	2026-06-23	2026-06-25
11	2026-06-24	2026-06-27
12	2026-06-27	2026-06-30
6	2026-06-29	2026-07-04
15	2026-07-04	2026-07-07
7	2026-07-07	2026-07-12
EOF

echo "Resolving project $OWNER/projects/$PROJECT_NUMBER ..."
PROJECT_ID=$(gh project view "$PROJECT_NUMBER" --owner "$OWNER" --format json --jq '.id')

FIELDS_JSON=$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json)
START_FIELD_ID=$(echo "$FIELDS_JSON" | jq -r --arg n "$START_FIELD" '.fields[] | select(.name==$n) | .id')
END_FIELD_ID=$(echo "$FIELDS_JSON"   | jq -r --arg n "$END_FIELD"   '.fields[] | select(.name==$n) | .id')

if [[ -z "$START_FIELD_ID" || -z "$END_FIELD_ID" || "$START_FIELD_ID" == "null" || "$END_FIELD_ID" == "null" ]]; then
  echo "Could not find date fields named '$START_FIELD' / '$END_FIELD'." >&2
  echo "Available fields on the project:" >&2
  echo "$FIELDS_JSON" | jq -r '.fields[] | "  \(.name)  [\(.type)]"' >&2
  echo "Edit START_FIELD/END_FIELD at the top of this script to match." >&2
  exit 1
fi

ITEMS_JSON=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 200)

while IFS=$'\t' read -r ISSUE START END; do
  [[ -z "${ISSUE:-}" ]] && continue
  ITEM_ID=$(echo "$ITEMS_JSON" | jq -r --argjson n "$ISSUE" '.items[] | select(.content.number==$n) | .id')
  if [[ -z "$ITEM_ID" || "$ITEM_ID" == "null" ]]; then
    echo "Issue #$ISSUE is not on project $PROJECT_NUMBER yet — add it, then re-run. Skipping." >&2
    continue
  fi
  echo "Setting #$ISSUE  start=$START  end=$END"
  gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "$START_FIELD_ID" --date "$START"
  gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "$END_FIELD_ID"   --date "$END"
done <<< "$SCHEDULE"

echo "Done."
