#!/usr/bin/env python3
"""
Meta / Instagram access-token setup.

Run from the directory containing `agency-next/`:

    python scripts/setup_meta_token.py

Standard library only.

Two things this guards against, both of which produce a system that looks
healthy and is not:

  * A token missing `instagram_manage_insights` publishes perfectly and then
    returns zeros for every analytics call, for ever. So it is checked before
    anything else happens, and refused.

  * A Page token derived from a SHORT-lived user token inherits its one-hour
    life. Derived from a LONG-lived one it never expires. The order below is
    the whole point.
"""

import getpass
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

APP_ID = os.environ.get("META_APP_ID", "910728721462221")
GRAPH = "https://graph.facebook.com/v21.0"
ENV_PATH = os.path.join("agency-next", ".env.local")

REQUIRED_PERMS = [
    "instagram_basic",
    "instagram_content_publish",
    "instagram_manage_insights",   # the one that silently breaks analytics
    "pages_show_list",
    "pages_read_engagement",
]

# Instagram refuses account insights below this. It is a fact about the
# account, not a misconfiguration, so it must not fail the run.
MIN_FOLLOWERS_FOR_INSIGHTS = 100


def die(msg):
    print(f"\n[x] {msg}", file=sys.stderr)
    sys.exit(1)


def api_get(path, params, fatal=True):
    """
    GET a Graph endpoint.

    `fatal=False` returns an {"error": ...} dict instead of exiting. Callers
    that are probing rather than depending on the result use it — an account
    that cannot serve insights must not abort a run that has already done the
    irreversible work of exchanging the token.
    """
    url = f"{GRAPH}/{path}?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            err = json.loads(body)["error"]["message"]
        except Exception:
            err = body[:200]
        if fatal:
            die(f"Graph API error on /{path}: {err}")
        return {"error": err}
    except Exception as e:
        if fatal:
            die(f"Network error on /{path}: {e}")
        return {"error": str(e)}


def mask(tok):
    return f"{tok[:6]}...{tok[-4:]} (len {len(tok)})" if tok else "(empty)"


# ---------------------------------------------------------------- 1. inputs
print("\nGet a token: https://developers.facebook.com/tools/explorer")
print("Tick: " + ", ".join(REQUIRED_PERMS) + "\n")

user_token = getpass.getpass("  User Access Token (hidden): ").strip()
if not user_token:
    die("No token entered.")

app_secret = getpass.getpass("  App Secret (hidden): ").strip()
if not app_secret:
    die("No app secret entered.")

# ---------------------------------------------------- 2. verify permissions
print("\nVerifying permissions...")
perms = api_get("me/permissions", {"access_token": user_token})
granted = {p["permission"] for p in perms.get("data", []) if p.get("status") == "granted"}

missing = [p for p in REQUIRED_PERMS if p not in granted]
for p in REQUIRED_PERMS:
    print(f"  {'[ok]' if p in granted else '[--]'} {p}")

if missing:
    die("Missing: " + ", ".join(missing) +
        "\n    Regenerate the token in Graph Explorer with every box ticked."
        "\n    Nothing has been changed on your machine.")
print("  All required permissions present.")

# ------------------------------------------------ 3. long-lived user token
print("\nExchanging for a 60-day long-lived user token...")
ll = api_get("oauth/access_token", {
    "grant_type": "fb_exchange_token",
    "client_id": APP_ID,
    "client_secret": app_secret,
    "fb_exchange_token": user_token,
})
long_token = ll["access_token"]
print(f"  Long-lived user token: {mask(long_token)}")

# ---------------------------------------------------- 4. derive page tokens
# One call with field expansion rather than one per Page: fewer requests
# against the rate limit, and no partial state if a later Page errors.
print("\nFinding Pages and deriving non-expiring Page tokens...")
accounts = api_get("me/accounts", {
    "access_token": long_token,
    "fields": "id,name,access_token,instagram_business_account{id,username,followers_count}",
})

ig_accounts = []
for pg in accounts.get("data", []):
    iga = pg.get("instagram_business_account")
    if not iga:
        print(f"  {pg.get('name', pg['id'])}: no Instagram Business account linked")
        continue
    ig_accounts.append({
        "page": pg.get("name", pg["id"]),
        "id": iga["id"],
        "username": iga.get("username", "?"),
        "followers": iga.get("followers_count", 0),
        "token": pg["access_token"],
    })

if not ig_accounts:
    die("No Instagram Business account is connected to any of your Pages.")

# Any Page token from this long-lived user token works for every account on
# it, so the first is as good as any -- and it does not expire.
final_token = ig_accounts[0]["token"]

# ---------------------------------------------------------- 5. test insights
# Probing only. A failure here is information, never a reason to abort: the
# token exchange above is already done and discarding it would mean starting
# over with a fresh Graph Explorer token.
print("\nTesting a real insights call on each account...")
for a in ig_accounts:
    if a["followers"] < MIN_FOLLOWERS_FOR_INSIGHTS:
        print(f"  [--] @{a['username']} ({a['followers']} followers) "
              f"- under {MIN_FOLLOWERS_FOR_INSIGHTS}, Instagram will not serve insights")
        continue
    res = api_get(f"{a['id']}/insights",
                  {"metric": "reach", "period": "day", "access_token": final_token},
                  fatal=False)
    if "error" in res:
        print(f"  [--] @{a['username']}: {res['error']}")
    else:
        print(f"  [ok] @{a['username']}: insights reachable")

# ------------------------------------------------------- 6. write .env.local
print(f"\nWriting META_ACCESS_TOKEN into {ENV_PATH} ...")
os.makedirs(os.path.dirname(ENV_PATH), exist_ok=True)

lines = []
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

replaced = False
for i, line in enumerate(lines):
    if line.startswith("META_ACCESS_TOKEN="):
        lines[i] = f"META_ACCESS_TOKEN={final_token}"
        replaced = True
        break
if not replaced:
    lines.append(f"META_ACCESS_TOKEN={final_token}")

with open(ENV_PATH, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
print("  Done." + ("  (updated existing key)" if replaced else "  (added new key)"))

# --------------------------------------------------------------- 7. summary
print("\n" + "=" * 62)
print("Instagram account ids -- set these on each client in the portal:")
for a in ig_accounts:
    note = "" if a["followers"] >= MIN_FOLLOWERS_FOR_INSIGHTS else "   <- no insights"
    print(f"  {a['id']}   @{a['username']:<20} {a['followers']:>7} followers{note}")

# The token is deliberately NOT printed. It never expires, so anything that
# echoes it -- scrollback, a screen share, a terminal log -- is a permanent
# credential leak. Read it from the file when it is needed.
print("\nPush to Vercel (reads the token from the file, never echoes it):")
print('  cd agency-next')
print('  node -e "const v=require(\'fs\').readFileSync(\'.env.local\',\'utf8\')'
      '.match(/^META_ACCESS_TOKEN=(.*)$/m)[1]; process.stdout.write(v)" '
      '| npx vercel env add META_ACCESS_TOKEN production')
print('  npx vercel --prod')
print("=" * 62)
print("\nThis Page token does not expire -- no 60-day renewal required.\n")
