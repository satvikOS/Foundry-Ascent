#!/usr/bin/env bash
# The owner's approval of one paid lab run above the USD 2 cap (docs/runbooks/conversation-lab.md "Spend cap").
#
#   scripts/approve-spend.sh <budget_usd>
#
# Asks for the owner's spend key (the value of the repository secret OWNER_SPEND_KEY, kept in the owner's password
# manager and nowhere in this repository) without echoing it, and prints the text to put in the workflow input
# approved_over_cap: "I approve USD <budget_usd> <code>". The code is an HMAC-SHA256 of the budget, exactly as typed,
# and today's date in UTC, so it approves that budget only, only until 00:00 UTC. ops-conversation-lab.yml and
# ops-live-evals.yml compute the same code from the secret and refuse a budget above 2 without it.
#
# Only the owner runs this: an agent or operator who needs more than USD 2 asks the owner for the approval.
set -euo pipefail

budget="${1:-}"
if [[ ! "${budget}" =~ ^[0-9]{1,3}(\.[0-9]{1,2})?$ ]] || ! awk -v b="${budget}" 'BEGIN { exit !(b > 2 && b <= 200) }'; then
  echo "usage: scripts/approve-spend.sh <budget_usd>  (above 2, at most 200, as it will be typed in budget_usd)" >&2
  exit 2
fi

if [ -n "${OWNER_SPEND_KEY:-}" ]; then
  key="${OWNER_SPEND_KEY}"
else
  read -r -s -p "Owner spend key (OWNER_SPEND_KEY): " key
  echo >&2
fi

OWNER_SPEND_KEY="${key}" python3 - "${budget}" <<'PY'
import datetime, hashlib, hmac, os, sys

budget = sys.argv[1]
key = os.environ["OWNER_SPEND_KEY"].strip()
if len(key) < 32:
    sys.exit("the spend key is at least 32 characters (openssl rand -hex 32 makes one)")
day = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
message = f"foundry-ascent spend approval|USD {budget}|{day}".encode()
code = hmac.new(key.encode(), message, hashlib.sha256).hexdigest()[:20]
print(f"I approve USD {budget} {code}")
print(f"(valid for budget_usd={budget} until 00:00 UTC after {day})", file=sys.stderr)
PY
