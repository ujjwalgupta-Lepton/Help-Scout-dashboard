# Help Scout ticket dashboard (read-only)

Shows, for the last 7 days, last 30 days, last calendar month, last 6 months or last 12 months:
- Tickets created per day / month
- Open and pending tickets right now, and closed tickets for the period
- Tickets by mailbox, channel, tag, agent (assigned / closed) and company

It only **reads** from the Help Scout Inbox API 2.0. It never replies to, changes or deletes anything,
and it never stores ticket content, only counts.

## Help Scout credentials
**Your Profile → My Apps → Create My App** in Help Scout. This is just where Help Scout issues API keys
(an App ID + App Secret). Nothing is installed in your account. The Redirect URL is not used; any https URL works.

## Deploy on Vercel
1. Push this folder to a GitHub repo (`.env` is git-ignored) and import it in Vercel, or run `npx vercel` here.
   Framework preset: **Other**. No build command is needed.
2. In the Vercel project, **Settings → Environment Variables**, add:
   - `HELPSCOUT_APP_ID`, `HELPSCOUT_APP_SECRET`
   - `DASHBOARD_PASSWORD`: required; the browser asks for it (any username)
   - `DASHBOARD_TIMEZONE`: e.g. `Asia/Kolkata` (Vercel servers run on UTC)
3. Recommended: **Storage → Marketplace → Upstash (Redis)**, free tier, connected to the project. This shares the
   cache between Vercel's function instances; without it, long ranges are re-read from Help Scout more often.
4. Redeploy so the variables take effect.

The first load of the 6- or 12-month view reads every ticket in that period (25 per API call), which can take
1–3 minutes. Each finished month is then cached for `PAST_CACHE_HOURS` (6 h), so later loads are fast and only the
current month is re-read. If a first load times out, open it again: it continues from the months already cached.

## Run locally
Copy `.env.example` to `.env`, fill it in, then `npm start` and open http://localhost:3000 (Node 18+, no packages
to install). Preview with made-up data, no credentials needed: `npm run demo`

## Settings (env variables)
| Variable | Default | Meaning |
|---|---|---|
| `COMPANY_SOURCE` | `domain` | `domain` = customer email domain; `customer` = Company field on the customer profile (one extra API call per customer) |
| `CACHE_MINUTES` | 10 | How long current-month data is reused |
| `PAST_CACHE_HOURS` | 6 | How long finished months are reused |
| `MAX_CALLS_PER_MINUTE` | 200 | Cap on Help Scout calls, leaving room for other integrations under the 400/min account limit |
| `MAX_PAGES` | 400 | Max pages (25 tickets each) read per month for the breakdowns |

The Refresh button re-reads the current month; finished months refresh after `PAST_CACHE_HOURS`.
Keep the App Secret private: it gives API access to your whole Help Scout account.
