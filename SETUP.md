# Setup — what only you can do

Everything in this file needs a browser, a password, or a credit card, which is why it isn't scripted. Nothing else is left: once these values are in `.env.local`, the app runs.

Run `npm run preflight` at any point. It tells you exactly which of these steps is still outstanding and what to do about it.

---

## 1 · Supabase (~10 minutes)

The app needs its own project. It does **not** touch GomaAI's database.

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**. Pick a region near your users (Singapore, if that's the market). Save the database password somewhere — you need it in step 3 and it is not recoverable.
2. **Project Settings → API**, copy three values into `.env.local`:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` — **server-only, never ship it to a browser**
3. Apply the migrations:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

`link` prompts for the database password from step 1. If you'd rather not use the CLI, open the SQL editor and paste each file in `supabase/migrations/` in filename order instead — they're plain SQL.

> **Apply all three locally. Apply only the middle one to GomaAI.** `..._platform_standins.sql` and `..._sandbox.sql` exist so this app can run alone; `..._lifecycle_events.sql` is the piece that eventually merges into the host. The file headers say so in capitals.

**Check:** `npm run preflight` should report the tables found.

---

## 2 · AI key (~2 minutes)

`ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com). This is the one model call in the product — drafting the suggested opener — so spend is roughly one short call per reminder sent.

`OPENAI_API_KEY` is optional. It's used only when Anthropic returns a capacity error, so without it a busy minute means a reminder falls back to a canned line instead of a drafted one. Nothing breaks.

---

## 3 · WhatsApp — the long pole (hours, mostly waiting)

**Start this first if you want to demo on a real phone this week.** Meta's template review is the only step with a queue in front of it. Everything else in this product works without it — see [Sandbox](#the-sandbox) below.

### 3a · Get a number onto the WhatsApp Business Platform

1. [business.facebook.com](https://business.facebook.com) → a Business account (or reuse an existing one).
2. [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App → Business** → add the **WhatsApp** product.
3. Add a phone number to the WhatsApp Business Account.
   - It **cannot** be a number currently registered to a personal WhatsApp or WhatsApp Business app. Delete that account first, or use a fresh number.
   - A virtual number is fine as long as it can receive the verification code.
4. From **WhatsApp → API Setup**, copy into `.env.local`:
   - **Phone number ID** → `GOMA_NOTIFY_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** → `GOMA_NOTIFY_WABA_ID`

### 3b · Get a token that doesn't expire

The token on the API Setup page is a **24-hour temporary token**. Fine for a first test, useless by tomorrow.

For anything lasting: **Business Settings → Users → System users** → add a system user → **Generate token**, select your app, and grant both
`whatsapp_business_messaging` and `whatsapp_business_management`. Set the expiry to *Never*.

→ `GOMA_NOTIFY_ACCESS_TOKEN`

### 3c · Register the template and wait

```bash
npm run template:register -- --dry     # inspect the exact payload first
npm run template:register              # submit for review
npm run template:register -- --status  # poll until APPROVED
```

**Do not turn off dry-run until this reports `APPROVED`.** A reminder sent against a pending template fails, burns all three retries in about 45 minutes, and lands terminally `failed`.

If it's **REJECTED**, `--status` prints Meta's reason. The usual causes are a missing example value or a category mismatch — the script submits `UTILITY` with examples, which is the correct shape for an internal staff notification.

### 3d · Go live

Set `REMINDER_DRY_RUN=0` (or delete the line). The app refuses to boot with it set in production, so you can't ship it on by accident.

### Two Meta limits worth knowing

- **An unverified business can message 250 unique recipients per rolling 24 hours.** Reminders go to *your agents*, not your clients, so a 30-person agency is nowhere near it. Business Verification raises it if you ever need that.
- **The receiving number must be a real WhatsApp account.** An agent whose number isn't on WhatsApp silently gets nothing — the send succeeds at the API level. `npm run preflight` flags members without numbers; it can't tell you whether a number is on WhatsApp.

---

## 4 · Deploy (~10 minutes, whenever you're ready)

1. Import the repo into Vercel.
2. Copy every variable from `.env.local` into **Project Settings → Environment Variables**, plus:
   - `APP_PUBLIC_URL` = your real deployment URL, absolute, no trailing slash. This becomes the deep link inside every reminder; the app validates it at boot precisely because a wrong value fails silently otherwise.
   - `CRON_SECRET` = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. `vercel.json` already schedules `/api/cron/process-reminders` every 15 minutes.

> **Check your Vercel plan.** Hobby allows one cron invocation *per day*, which makes reminders effectively useless. On Hobby, point any external scheduler at the same endpoint:
> ```bash
> curl -X POST https://<your-app>/api/cron/process-reminders -H "Authorization: Bearer $CRON_SECRET"
> ```

---

## 5 · First run

```bash
npm run dev
```

1. **Sign up.** The first authenticated request mints your business — this is the only way a business gets created, so it must happen before the seed script.
2. **Settings** → set your timezone. This is load-bearing: a "morning" reminder means 9am *there*, and the wrong zone moves every reminder by hours.
3. **Seed a roster and rules:**
   ```bash
   npm run seed:demo -- --email you@example.com
   ```
4. **Import** → upload `tests/fixtures/sample-clients.csv`. Confirm the column mapping, confirm the date format, commit.
5. **Sandbox** → **Run a tick now**.

---

## The sandbox

`/sandbox` exists so none of the above blocks a demo.

It is **not a mock**. "Run a tick now" calls the same `runReminderCycle` the cron calls; the message you see is written by the same delivery path, with the same five template params, already clamped and whitespace-collapsed exactly as Meta would receive them. The only substitution is the final HTTP POST.

So you can show the whole product — import, attribution, the review queue, materialisation, the drafted opener, the agent's handset, forwarding to a client — with no phone number and no approved template. When the template lands, you flip one flag and the same code sends for real.

---

## What'll go wrong first

In rough order of likelihood:

| Symptom | Cause |
|---|---|
| Dates imported, queue stays empty | No rule matches that `event_type`. The banner on **Reminders** names it and suggests the fix. |
| An import sent more messages than expected | Contacts whose date was already inside its lead time go out on the next run. The import screen reports how many before it happens — pause a rule in Settings first if you want a quiet import. |
| Every reminder is `skipped` | No WhatsApp credentials, or no recipient — an unassigned contact falls back to the **owner**, and if no team member has `role = owner` there is nobody to fall back to. |
| Reminders fire at the wrong hour | Business timezone is wrong or unset. |
| Deep link goes nowhere | `APP_PUBLIC_URL` doesn't match where the app actually runs. |
| Nothing happens on schedule | Vercel Hobby cron, or `CRON_SECRET` differs between the scheduler and the app. |
| Every reminder terminally `failed` ~45 min after going live | Template wasn't `APPROVED` yet. |
