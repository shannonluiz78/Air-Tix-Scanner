# FareBoard

A flight-deal tool you host yourself on GitHub Pages: search across four
engines at once, get timing advice on when to buy, and set price alerts
that notify you through GitHub — no server, no database, no monthly bill.

## What it actually does (read this first)

Two things changed in 2026 that shape how this app works:

- **Amadeus' free developer API shut down on July 17, 2026.** Kiwi's
  Tequila API went invite-only around the same time. There is currently
  no free, self-serve, live flight-pricing API for indie projects.
- **There's no public Google Flights API** and hasn't been since 2018.

So FareBoard is built on what's actually available:

1. **Search** — the app doesn't fetch prices itself. It builds correct,
   pre-filled deep links into Google Flights, Skyscanner, Kayak, and
   Momondo, so you see real, live prices on the real sites, one click
   each. This is more reliable than any scraper.
2. **Timing advice** — a rule-based recommendation using published 2026
   aggregate research (Going.com, Google Flights historical fare
   analysis, Expedia's Air Hacks report, Kayak). It tells you whether
   you're in the historically-cheap booking window for your route
   type — general guidance, not a live prediction for your flight.
3. **Alerts** — uses the [Travelpayouts Data API](https://www.travelpayouts.com/)
   (free, still active), which returns *cached* fares from real user
   searches on Aviasales/Jetradar's network — not a live quote, but a
   solid directional signal, refreshed continuously and free to use.
   A GitHub Action checks it every 6 hours and comments on your alert
   issue when your target price shows up.

## One-time setup

### 1. Make this your own repo
Push this folder to a **public** GitHub repo (Pages + the free Actions
tier both need public for the smoothest experience; private works too
but Pages requires GitHub Pro/Team and Actions has a monthly minute cap).

### 2. Turn on GitHub Pages
Repo → **Settings → Pages** → Source: `Deploy from a branch` → Branch:
`main` / `root`. Your app will be live at
`https://<your-username>.github.io/<repo-name>/`.

### 3. Edit one config file
Open `assets/config.js` and set:
```js
GITHUB_OWNER: "your-github-username",
GITHUB_REPO: "your-repo-name",
```
Commit it. This is the only code change required to make the app work.

Also update the link in `.github/ISSUE_TEMPLATE/config.yml` to your
Pages URL (cosmetic — it's just the "back to the app" link GitHub shows
when someone opens the issue picker).

### 4. Get a free Travelpayouts token (for alerts)
1. Sign up at <https://www.travelpayouts.com/> (free, no traffic
   requirements — it's an affiliate account, you just won't use the
   affiliate-link part).
2. Go to **Tools → API** and copy your API token.
3. In your repo: **Settings → Secrets and variables → Actions → New
   repository secret**. Name: `TRAVELPAYOUTS_TOKEN`. Value: your token.

That's it — `GITHUB_TOKEN` is provided automatically by Actions, you
don't need to create it.

### 5. Turn on Actions (if prompted)
First visit to the **Actions** tab may ask you to enable workflows for
the repo — click enable. The `Price watch` workflow will then run every
6 hours automatically, and immediately whenever a new watch issue is
opened.

### 6. Optional: deploy the live snapshot API (free, on Vercel)
This adds an on-demand "cached price snapshot" panel — best price per
airline seen in cache, plus a price-by-date trend line — instead of
only waiting for the 6-hourly alert check. Same free Travelpayouts
data, just queried live when you hit the button.

1. On [vercel.com](https://vercel.com), **Add New → Project → Import**
   the same GitHub repo (no need for a second repo — the `/api` folder
   is the only part Vercel uses; it ignores the rest).
2. In the new Vercel project's **Settings → Environment Variables**,
   add `TRAVELPAYOUTS_TOKEN` with the same token from step 4. (Vercel
   keeps this server-side — it's never sent to the browser.)
3. Deploy. Vercel gives you a URL like
   `https://fareboard-yourname.vercel.app`.
4. Back in `assets/config.js`, set:
   ```js
   SNAPSHOT_API_BASE: "https://fareboard-yourname.vercel.app",
   ```
5. Commit. The "Cached price snapshot" panel on the site will now work.

If you skip this step, the app still works fully — you just won't see
the snapshot panel, only the compare links, timing gauge, and alerts.

## Using it day to day

1. Open the site, fill in your route and dates.
2. Check the timing gauge — it'll tell you if you're too early, in the
   sweet spot, or past it.
3. Tap through to the engine you trust most and check the real price.
4. If it's not quite there yet, set an alert: enter your target price
   and tap **Create alert on GitHub**. This opens a pre-filled GitHub
   Issue — just tap **Submit new issue**.
5. Leave the issue open. When the Action finds a cached price at or
   below your target, it comments on the issue with links to book. You
   get notified the same way you get notified about any GitHub issue
   activity — check your GitHub notification settings (email + the
   GitHub mobile app both work well for "tap and go book it" alerts).
6. Close the issue once you've booked.

You can also create a watch directly from the repo's **Issues → New
issue** on GitHub itself (useful from the GitHub mobile app when
you're not near the site).

## Honest limitations

- Travelpayouts' cache can be up to ~7 days stale and is strongest on
  well-searched routes. Thin or unusual routes may return nothing —
  the bot will tell you once, not spam you.
- It's a *signal*, not a booking price. Always confirm on the real
  site before paying — the alert comment links straight there.
- The timing advice is general research, not machine learning on your
  specific route. Treat the gauge as a nudge.
- Unauthenticated GitHub API reads (used by the "Your active watches"
  list on the site) are rate-limited to 60 requests/hour per visitor
  IP — plenty for personal use, not built for public traffic.

## Testing it before you trust it

- Run the workflow manually: **Actions → Price watch → Run workflow**.
- Check the run's logs — it prints what it found for each open watch.
- Try a well-known busy route first (e.g. SIN → BKK) to confirm the
  Travelpayouts token works before relying on a niche route.

## File map

```
index.html                          the app
assets/style.css                    styling
assets/app.js                       search links + timing engine + alert UI
assets/airports.js                  autocomplete list
assets/config.js                    ← the one file you edit
.github/ISSUE_TEMPLATE/price-watch.yml   the alert "form" = the database schema
.github/workflows/price-watch.yml   the scheduled checker
scripts/check_prices.py             what the checker actually runs
api/prices.js                       optional Vercel function — on-demand snapshot
package.json                        makes Vercel recognize api/ as a Node function
```

## Why two hosts?

GitHub Pages only serves static files — it can't run backend code, so
it can't safely call Travelpayouts on demand (the browser would either
get blocked by CORS or have to expose the token client-side). Vercel's
free tier runs the `/api` function on-demand with no server to keep
alive. The site (Pages) and the snapshot API (Vercel) are two separate,
both-free deployments of the *same* repo — nothing to keep in sync by
hand beyond the one URL in `config.js`.
