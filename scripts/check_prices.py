#!/usr/bin/env python3
"""
FareBoard price checker.

Reads open GitHub issues labeled "price-watch" (created from the
price-watch.yml issue form), looks up cached fare data from the
Travelpayouts Data API for each route, and comments on the issue +
adds a "deal-found" label when the cached cheapest price is at or
below the watch's target price.

Required environment variables (set as repo secrets / provided by Actions):
  GITHUB_TOKEN         - provided automatically by GitHub Actions
  GITHUB_REPOSITORY    - provided automatically, "owner/repo"
  TRAVELPAYOUTS_TOKEN  - free token from https://www.travelpayouts.com
                         (sign up as an affiliate, then Tools > API)

Notes / honest limitations:
- Travelpayouts serves CACHED prices from real user searches on its
  partner sites, refreshed on no fixed schedule, up to ~7 days old.
  It is a strong directional signal, not a live quote. Always confirm
  the real price on the booking site before buying.
- Coverage is best on well-searched routes. Thin/rare routes may
  return nothing — the script notes that once rather than every run.
"""

import os
import re
import sys
import json
import time
from datetime import datetime
import urllib.request
import urllib.parse
import urllib.error

GITHUB_API = "https://api.github.com"
TP_API = "https://api.travelpayouts.com/v1/prices/direct"

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
REPO = os.environ.get("GITHUB_REPOSITORY", "")
TP_TOKEN = os.environ.get("TRAVELPAYOUTS_TOKEN", "")

FIELD_LABELS = {
    "Origin airport (IATA code)": "origin",
    "Destination airport (IATA code)": "destination",
    "Depart date (YYYY-MM-DD)": "depart_date",
    "Return date (YYYY-MM-DD) — leave blank for one-way": "return_date",
    "Target price (numbers only)": "target_price",
    "Currency": "currency",
    "Cabin": "cabin",
}


def gh_request(path, method="GET", body=None):
    url = f"{GITHUB_API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {GITHUB_TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"GitHub API error {e.code} on {path}: {e.read().decode()}", file=sys.stderr)
        raise


def list_watch_issues():
    issues = []
    page = 1
    while True:
        data = gh_request(f"/repos/{REPO}/issues?state=open&labels=price-watch&per_page=50&page={page}")
        if not data:
            break
        issues.extend(data)
        if len(data) < 50:
            break
        page += 1
    return issues


def parse_body(body):
    fields = {}
    if not body:
        return fields
    chunks = re.split(r"\n?###\s+", body)
    for chunk in chunks:
        for label, key in FIELD_LABELS.items():
            if chunk.startswith(label):
                value = chunk[len(label):].strip()
                value = value.split("\n\n")[0].strip()
                if value == "_No response_":
                    value = ""
                fields[key] = value
    return fields


def find_min_price(node, best=None):
    """Recursively hunt for numeric 'price' leaves in the Travelpayouts response."""
    if isinstance(node, dict):
        if "price" in node and isinstance(node["price"], (int, float)):
            if best is None or node["price"] < best[0]:
                best = (node["price"], node)
        for v in node.values():
            best = find_min_price(v, best)
    elif isinstance(node, list):
        for v in node:
            best = find_min_price(v, best)
    return best


def check_travelpayouts(origin, destination, depart_date, return_date, currency):
    params = {
        "origin": origin,
        "destination": destination,
        "currency": (currency or "usd").lower(),
        "token": TP_TOKEN,
    }
    if depart_date:
        params["depart_date"] = depart_date[:7]  # month granularity = better cache hit rate
    if return_date:
        params["return_date"] = return_date[:7]
    url = f"{TP_API}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"Travelpayouts request failed: {e}", file=sys.stderr)
        return None
    if not data.get("success"):
        return None
    return find_min_price(data.get("data"))


def booking_links(origin, destination, depart_date, return_date, cabin):
    gf_q = f"Flights to {destination} from {origin} on {depart_date}"
    if return_date:
        gf_q += f" through {return_date}"
    google = "https://www.google.com/travel/flights?q=" + urllib.parse.quote(gf_q)

    def yymmdd(d):
        return d.replace("-", "")[2:] if d else ""

    sky = f"https://www.skyscanner.com/transport/flights/{origin.lower()}/{destination.lower()}/{yymmdd(depart_date)}/{yymmdd(return_date)}/"
    path = f"{origin}-{destination}/{depart_date}" + (f"/{return_date}" if return_date else "")
    kayak = f"https://www.kayak.com/flights/{path}?sort=bestflight_a"
    return google, sky, kayak


def last_notified_price(comments):
    for c in reversed(comments):
        m = re.search(r"<!-- notified_price: ([\d.]+) -->", c.get("body", ""))
        if m:
            return float(m.group(1))
    return None


def main():
    if not GITHUB_TOKEN or not REPO:
        print("Missing GITHUB_TOKEN or GITHUB_REPOSITORY — must run inside GitHub Actions.", file=sys.stderr)
        sys.exit(1)
    if not TP_TOKEN:
        print("TRAVELPAYOUTS_TOKEN secret is not set. Add it in repo Settings > Secrets and re-run.", file=sys.stderr)
        sys.exit(1)

    issues = list_watch_issues()
    print(f"Found {len(issues)} open price-watch issue(s).")

    for issue in issues:
        number = issue["number"]
        fields = parse_body(issue.get("body", ""))
        origin = fields.get("origin", "").upper()
        destination = fields.get("destination", "").upper()
        depart_date = fields.get("depart_date", "")
        return_date = fields.get("return_date", "")
        currency = fields.get("currency", "USD")
        cabin = fields.get("cabin", "economy")
        try:
            target_price = float(fields.get("target_price", "0"))
        except ValueError:
            target_price = 0

        if not (origin and destination and depart_date and target_price):
            print(f"#{number}: could not parse required fields, skipping.")
            continue

        labels = [l["name"] for l in issue.get("labels", [])]
        already_flagged = "deal-found" in labels

        result = check_travelpayouts(origin, destination, depart_date, return_date, currency)
        time.sleep(0.2)  # stay well under Travelpayouts' 10 req/sec

        if result is None:
            comments = gh_request(f"/repos/{REPO}/issues/{number}/comments")
            if len(comments) == 0:
                gh_request(
                    f"/repos/{REPO}/issues/{number}/comments",
                    method="POST",
                    body={
                        "body": (
                            f"No cached fare data found yet for **{origin} → {destination}**. "
                            "This route may be too thin for Travelpayouts' cache, or the dates are "
                            "too far out. I'll keep checking — meanwhile, check manually with the "
                            "links on the FareBoard site."
                        )
                    },
                )
                print(f"#{number}: no data, posted one-time note.")
            else:
                print(f"#{number}: no data, already noted once.")
            continue

        price, node = result
        print(f"#{number}: cheapest cached price {price} {currency} (target {target_price}).")

        if price <= target_price:
            comments = gh_request(f"/repos/{REPO}/issues/{number}/comments")
            prior = last_notified_price(comments)
            should_notify = (not already_flagged) or (prior is not None and price < prior * 0.95)

            if should_notify:
                google, sky, kayak = booking_links(origin, destination, depart_date, return_date, cabin)
                found_at = node.get("found_at", "recently")
                body = (
                    f"### 🔥 Price hit: {price} {currency}\n\n"
                    f"Cached data shows **{origin} → {destination}** around your target "
                    f"({target_price} {currency}). Spotted at: {found_at}.\n\n"
                    "This is cached/indicative — confirm the real price before buying:\n\n"
                    f"- [Google Flights]({google})\n"
                    f"- [Skyscanner]({sky})\n"
                    f"- [Kayak]({kayak})\n\n"
                    f"<!-- notified_price: {price} -->"
                )
                gh_request(f"/repos/{REPO}/issues/{number}/comments", method="POST", body={"body": body})
                if not already_flagged:
                    gh_request(
                        f"/repos/{REPO}/issues/{number}/labels",
                        method="POST",
                        body={"labels": ["deal-found"]},
                    )
                print(f"#{number}: notified.")
            else:
                print(f"#{number}: already notified at this price level, skipping.")


if __name__ == "__main__":
    main()
