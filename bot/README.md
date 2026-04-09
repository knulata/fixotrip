# FixoTrip WhatsApp Bot

LLM-driven WhatsApp bot (GPT-4o-mini) for free flight monitoring + paid travel-emergency intervention.

**Two products:**
- 🆓 **Watch My Trip** — user forwards a booking, the LLM calls `start_watching_trip`, the poller checks AviationStack every 15 min, and the user gets WhatsApped immediately on cancellation.
- 🆘 **Emergency Help** — user describes a problem, the LLM gathers details and calls `send_payment_link` for the $19 flat-fee rescue plan.

The LLM handles language, flight-detail extraction, and tone naturally — no regex or keyword routing.

## Setup

### 1. Install dependencies
```bash
cd bot
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env`:
- `FONNTE_TOKEN` — Get from fonnte.com dashboard
- `ADMIN_PHONE` — Your WhatsApp number for notifications
- `OPENAI_API_KEY` — Required. The bot is LLM-driven (GPT-4o-mini).
- `AVIATIONSTACK_KEY` — Optional. Get a free key from aviationstack.com (100 calls/day). Without it, the flight-status poller runs in stub mode and only logs.
- `POLL_SECRET` — Optional. Shared secret for the `/poll` endpoint when using external cron.

### 3. Run locally
```bash
npm run dev
```

### 4. Deploy to Railway/Render/Vercel

**Railway (Recommended):**
```bash
railway login
railway init
railway up
```

**Or Render:**
1. Connect GitHub repo
2. Add environment variables
3. Deploy

### 5. Configure Fonnte Webhook

1. Go to fonnte.com dashboard
2. Select your device
3. Set webhook URL: `https://your-app-url.com/webhook`
4. Save

## How It Works

### Free Trip Monitoring

1. User asks the bot to watch a trip (any phrasing — "watch my GA820 tomorrow", forwards a confirmation email, etc).
2. The LLM extracts the flight number, date, and route, then calls `start_watching_trip`.
3. Trip is stored in the in-memory `trips` Map keyed by sender phone.
4. `pollWatchedTrips()` runs every 15 minutes, calling AviationStack for each active trip.
5. On `cancelled` status, the bot synthesises a contextual message (in the user's language) via the LLM and WhatsApps it immediately, then notifies admin.

### Paid Emergency Help

1. User describes a problem.
2. The LLM gathers details naturally and calls `send_payment_link` when ready.
3. Admin gets notified.
4. After payment, the LLM calls `notify_payment_received` with a draft rescue plan for the admin to review and send.

## Endpoints

- `GET /` — health check, returns conversation + watched-trip counts
- `POST /webhook` — Fonnte webhook (incoming WhatsApp messages)
- `POST /poll` — manual poll trigger for serverless cron. Requires `x-poll-secret` header if `POLL_SECRET` is set.

## Deployment caveat: serverless vs long-running

The poller uses `setInterval`, which **only works on a long-running host** (Railway, Render, Fly.io). On Vercel serverless, processes are short-lived and `setInterval` won't fire.

**For serverless deploys:** disable the in-process interval and instead hit `POST /poll` from external cron — Vercel Cron, GitHub Actions on schedule, or cron-job.org. Set `POLL_SECRET` in env and pass it as the `x-poll-secret` header.

## TODO before scaling

- [ ] Move `conversations` and `trips` Maps to Postgres (Supabase/Neon). Cold starts currently lose all watches.
- [ ] EU261 / Montreal Convention claim filer flow as a third LLM tool.
- [ ] Stripe SetupIntent to capture saved payment method for off-session charging when we add automated rebook.
- [ ] Replace AviationStack with a more reliable / higher-quota source (FlightAware AeroAPI, Cirium, OAG) once volume justifies it.

## Customization

Edit `SYSTEM_PROMPT` in `index.js` to change tone, knowledge, or conversation flow. Edit the `tools` array to add new LLM-callable actions. Add new tool handlers in the `for (const toolCall ...)` loop inside `getAIResponse`.
