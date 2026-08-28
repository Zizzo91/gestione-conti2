#!/usr/bin/env python3
"""Carica i dati storici (JSON del repo) nelle tabelle Supabase.

Uso (usa la service_role key SOLO qui, mai nel frontend):
  python3 script/seed_supabase.py path/to/supabase-secrets.json

Opzionale: --skip-existing per non sovrascrivere righe già presenti.
"""
import argparse
import json
import os
import sys
import urllib.request

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def post(svc_url, key, table, rows, upsert_cols):
    url = f"{svc_url}/rest/v1/{table}"
    req = urllib.request.Request(
        url,
        data=json.dumps(rows).encode("utf-8"),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": f"resolution=merge-duplicates,return=minimal"
            + ("&columns=" + ",".join(upsert_cols) if upsert_cols else ""),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"POST {table} -> {e.code}: {e.read().decode('utf-8', 'replace')[:500]}") from e


def upsert(svc_url, key, table, rows, upsert_cols):
    if not rows:
        return 0
    status = post(svc_url, key, table, rows, upsert_cols)
    return len(rows), status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("secrets", nargs="?", help="percorso supabase-secrets.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    secrets = args.secrets or os.path.join(os.path.dirname(BASE_DIR), "Config Utility", "supabase-secrets.json")
    with open(secrets) as f:
        s = json.load(f)
    svc_url = s["project_url"].rstrip("/")
    key = s["service_role_key_secret"]

    with open(os.path.join(BASE_DIR, "data", "accounts.json")) as f:
        accounts = json.load(f)
    with open(os.path.join(BASE_DIR, "finance-backup.json")) as f:
        entries = json.load(f)
    for e in entries:
        e.setdefault("note", "")
    with open(os.path.join(BASE_DIR, "data", "budgets.json")) as f:
        budgets = json.load(f)

    budget_rows = []
    for th in budgets.get("thresholds", []):
        for account_id, amount in (th.get("accounts") or {}).items():
            if amount and amount > 0:
                budget_rows.append({"month": th["month"], "account_id": account_id, "amount": amount})

    print(f"accounts: {len(accounts)} righe")
    print(f"entries : {len(entries)} righe")
    print(f"budgets : {len(budget_rows)} righe")

    if args.dry_run:
        return

    out = {}
    out["accounts"] = upsert(svc_url, key, "accounts", accounts, ["id"])
    out["entries"] = upsert(svc_url, key, "entries", entries, ["month"])
    out["budgets"] = upsert(svc_url, key, "budgets", budget_rows, ["month", "account_id"])
    print("risultato upsert:", out)


if __name__ == "__main__":
    sys.exit(main())