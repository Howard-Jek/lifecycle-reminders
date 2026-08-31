# Lifecycle

Client dates worth a conversation, sent to the person who owns the relationship.

Insurance agents lose track of policy expiries, birthdays and review dates. Those are exactly the moments a message is welcome, and they slip past because nobody can watch a calendar of 200 clients. Lifecycle ingests client records, materialises a reminder queue, and WhatsApps **the agent** before each date lands — with a suggested opener they can edit and send themselves.

**The reminder never goes to the client automatically.** A human always stands between the draft and the lead.

This is a standalone add-on for [`jottiteam/lead-reactivation-agent`](https://github.com/jottiteam/lead-reactivation-agent) ("GomaAI"). It runs entirely on its own — its own Supabase project, its own deploy — but its schema and code are shaped to drop into GomaAI without translation. See [Integration](#integration).

---

## Three constraints

**1 · Not a one-trick pony.** Insurance dates are the first *configuration* of a generic temporal-trigger engine, not its shape. `contact_events.event_type` is free text: a warranty expiry, a visa renewal, an MOT, a subscription anniversary are rows, not code.

**2 · Agents only where judgement is required.** Date arithmetic, occurrence resolution, attribution, queueing and delivery are all deterministic functions. There is exactly **one** model call in the whole product: drafting the suggested opener. Even column mapping — which the prior art did with a model — is a lookup table plus a confirmation screen.

**3 · Attribution is the hard part.** One business, N agents, N×Y clients. A client attached to the wrong agent means the wrong person is reminded and the right one never is. Matching is **exact-only and never guesses**: a name that matches nothing, or matches two people, goes to a review queue.

---

## Reliability

- **Claim-then-send.** A conditional `UPDATE … WHERE status = 'queued'` wins the row before any observable side effect, so two overlapping ticks can never send twice.
- **At-most-once is Postgres's guarantee, not the application's** — `UNIQUE NULLS NOT DISTINCT (event_id, rule_id, occurrence_date, member_id)` on `reminders`.
- **Bounded.** 40 deliveries per tick, a 4-minute delivery budget, 3 attempts then terminal `failed`. A stuck-claim sweep reclaims rows a dead worker abandoned; rows that died on their last attempt go terminal rather than being requeued into invisibility.
- **`MAX_OVERDUE_DAYS = 7`** governs the mid-window case: an occurrence that is genuinely upcoming whose lead-time moment has already passed. Historical dates never reach this guard at all — a birthday from last month resolves to *next* year's occurrence. Seven days is chosen against the seeded rule spacing so a mid-window contact fires its **nearest** rule and not its earlier ones, and the import reports how many contacts land already inside their lead time so a burst is announced rather than a surprise.

Correctness details worth preserving:

- `nextOccurrence` clamps **29 Feb → 28 Feb** in common years.
- `reminderDueAt` resolves wall-clock send windows through a two-pass `Intl` round-trip, so 9am stays 9am across DST — in the *business's* timezone, not the server's.
- `parseCalendarDate` never routes through `toISOString()`: that converts to UTC and can shift the calendar day, which for a birthday is the entire value of the field.
- Cross-tenant fetches paginate around PostgREST's silent 1000-row cap.
- Drafting is best-effort: a model failure degrades to a canned line rather than blocking the reminder. If suggestions are off for a rule, **no model call is made at all**.

---

## Running it

```bash
npm install
cp .env.example .env.local   # fill it in
npm run dev
```

Apply all three migrations to a fresh Supabase project (`supabase/migrations/`, in filename order), then sign up — the first authenticated request mints your business. Only the middle one ever goes to GomaAI; see [Integration](#integration).

| Command | |
|---|---|
| `npm run dev` | dev server |
| `npm test` | vitest (158 tests) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run reminders:tick` | run one reminder cycle against `.env.local` |
| `npm run preflight` | what is configured, what is missing, and what to do about it |
| `npm run seed:demo -- --email you@…` | seed a team roster and the starter rules |
| `npm run template:register` | submit the WhatsApp template (`-- --status` to poll) |

### Nothing sends until Meta approves the template

Delivery is WhatsApp-only. `client_event_reminder` (5 body params, `UTILITY`) has to be **APPROVED** on the WABA named by `GOMA_NOTIFY_WABA_ID` before a single reminder lands. That review takes hours and is always the long pole — register it first.

Until then, set `REMINDER_DRY_RUN=1`. The sender logs the exact payload it would send and stamps a synthetic message id, so **every other stage** — import, attribution, materialisation, claiming, drafting, the queue UI, the ICS feed — is exercisable on day one. `src/lib/env.ts` refuses to boot with that flag set in a production runtime.

---

## How it fits together

```
spreadsheet ─┐
             ├─→ ingestContacts() ─→ leads + contact_events ─┐
POST /api/v1─┘         │                                     │
                       └─→ contact_import_reviews            │
                           (nothing is ever guessed)         │
                                                             ▼
                              reminder_rules  ×  contact_events
                                          │
                                   planReminders()          ← pure, no I/O
                                          │
                                          ▼
                                     reminders               ← the queue
                                          │
                              claim → draft → WhatsApp → stamp
```

| Path | |
|---|---|
| `src/lib/lifecycle/occurrence.ts` | the date maths — leap days, DST, per-tenant "today" |
| `src/lib/lifecycle/plan-reminders.ts` | pure materialiser: (events × rules × recipients) |
| `src/lib/lifecycle/claim-reminder.ts` | claim / release / stamp / sweep |
| `src/lib/lifecycle/run-cycle.ts` | the cycle, with no scheduler import |
| `src/lib/lifecycle/match-member.ts` | exact-match attribution |
| `src/lib/lifecycle/suggest-message.ts` | **the one model call** |
| `src/lib/lifecycle/ics.ts` | RFC 5545 — 75-octet folding, escaping |
| `src/lib/import/ingest.ts` | the single path contacts take into the database |
| `src/app/api/cron/process-reminders` | Vercel Cron driver (`*/15`) |
| `src/trigger/process-reminders.ts` | Trigger.dev driver — for the host, not wired up here |

### Three drivers, one engine

`runReminderCycle()` imports nothing about how it was triggered. The standalone drives it from an authenticated route on a Vercel cron; the host drives it from a Trigger.dev task; `npm run reminders:tick` drives it from a terminal. Swapping between them changes no behaviour — which is why the Trigger.dev wrapper ships even though nothing here calls it.

> **Vercel plan caveat:** Hobby allows one cron invocation per day. On Hobby, point any external scheduler at `POST /api/cron/process-reminders` with `Authorization: Bearer $CRON_SECRET`.

---

## Integration

The migrations are split, and the split *is* the integration strategy.

**The schema is committed, so you do not need this checkout to read it:**

| | |
|---|---|
| [`supabase/schema/full.sql`](supabase/schema/full.sql) | Every migration. Builds a **fresh standalone** Supabase project. Paste it into the SQL editor and run once. |
| [`supabase/schema/addon.sql`](supabase/schema/addon.sql) | The eight migrations that go into an **existing GomaAI** database. |

Both are generated by `npm run db:schema`, and `tests/unit/schema-bundle.test.ts`
fails if either has drifted from `supabase/migrations/` — so the committed copy
cannot go stale. The classification lives in `STANDALONE_ONLY` in
`scripts/sql-bundle.ts`; a new migration is host-bound unless it is listed there.

**Standalone only — never apply these to GomaAI:**

| File | |
|---|---|
| `20260811000000_platform_standins.sql` | A narrowed copy of GomaAI's `businesses`, `business_members`, `member_business_ids()`, `update_updated_at()`, `send_window` and `leads`. |
| `20260811020000_sandbox.sql` | The sandbox transcript table. |
| `20260815120000_revoke_anon.sql` | Also changes `DEFAULT PRIVILEGES` for every future table in the database — a database-wide decision that deserves its own change, not a ride-along on a feature merge. |
| `20260901010000_vertical_standin.sql` | `businesses.vertical`. The host already has this column and its twelve-value CHECK. |

**Host-bound — this is `addon.sql`:** `lifecycle_events` (the core artefact —
creates no new functions and no new types, because every one of those names is
collision surface), `whatsapp_inbound`, `status_events`, `scheduler_runs`,
`event_type_counts`, `auto_send_flag`, `reminder_error_code`,
`reminder_retry_schedule`.

> As of 2026-08-31 `jottiteam/staging` has already taken the first six, as
> `20260830120000_lifecycle_reminders`, `…120100_reminders_whatsapp_inbound`,
> `…120200_reminders_status_events` and `20260831120000_reminders_send_safety`.
> Only `reminder_error_code` and `reminder_retry_schedule` are new to it.

At integration:

1. Apply `supabase/schema/addon.sql`. Do **not** apply the stand-ins.
2. Delete `src/lib/supabase/*`, `src/lib/tenant.ts`, `src/components/ui/*`, `globals.css`, the auth routes — the host already has all of them, identical.
3. Move `src/lib/lifecycle/*`, `src/lib/import/*`, `src/lib/notify/*`, the app routes and the tests across unchanged.
4. Swap the cron route for `src/trigger/process-reminders.ts` and add it to `trigger.config.ts`'s `dirs`.
5. Point `src/lib/ai/model.ts` at whatever the host pins.
6. Reuse the host's existing `GOMA_NOTIFY_*` credentials — the env var names are deliberately identical, so this is a no-op.

**Implementation rule the stand-ins create:** never `select('*')` on `leads` or `businesses`. Column-narrow selects run identically against the stand-in and the real thing; `*` returns a wider row in GomaAI.

### Four schema decisions

**`team_members`, not `business_members`.** `business_members.user_id` is `NOT NULL → auth.users` with `UNIQUE(user_id)`, so folding the roster into it would make every agent who should merely *receive* a WhatsApp into a provisioned login seat. `team_members` is the single **attribution** roster; `auth_user_id` is the *optional* link to a seat, enforced by a composite FK so a linked seat must belong to the same business.

**Composite FKs, not a tenant-check trigger.** `(lead_id, business_id) REFERENCES leads(id, business_id)` and the same for every other child. Stronger than the `plpgsql` trigger it replaces: it survives `session_replication_role = replica` (which Supabase's own restore path sets), it cannot be quietly disabled, and it makes cross-tenant rows *unrepresentable* rather than rejected at runtime. It also closed a real leak — `reminders.member_id` was a single-column FK, so a reminder about business A's client could be delivered to business B's agent.

**Calendar tokens live in their own table, hashed.** RLS is row-level, not column-level: a token on `team_members` under a member-SELECT policy is readable by every colleague via `select('*')`, and it grants unauthenticated, unexpiring read of that member's whole feed. So it lives in a secret table (RLS on, zero policies) and only its SHA-256 is stored.

**`reminders.member_id` is `ON DELETE NO ACTION`, not `RESTRICT`.** `RESTRICT` fires immediately, before sibling cascades run — so deleting a business would abort permanently for any tenant that had ever sent a reminder. `NO ACTION` defers to end-of-statement, while a *direct* delete of a team member still fails loudly.

> Both `ON DELETE SET NULL (column)` and `UNIQUE NULLS NOT DISTINCT` need **PostgreSQL 15+**. Supabase is; confirm before applying to production.

---

## Known limits

- **Reminders are readable business-wide**, including the drafted suggestion. That matches the host's posture for `leads` and is almost certainly what a small agency wants — but decide it consciously before selling to anyone who cares. Tightening it means a per-member predicate on the policies, which re-introduces the seat requirement.
- **No retention.** `reminders` grows one row per event × rule × year, forever.
- **The per-tick delivery cap is global**, ordered by `due_at`. It bounds spend but does not stop one busy tenant dominating a tick.
- **Guardrails are stubbed** (`NO_GUARDRAILS`). The host loads them per business; the wiring is one call in `loadDeliveryContext`.
- The `middleware` file convention is deprecated in Next 16 in favour of `proxy`. It still works; renaming is a follow-up.
- `globals.css` differs from the host by exactly one line — the `shadcn/tailwind.css` import is spelled out as a path, because Tailwind v4's CSS resolver does not apply that package's `"style"` export condition.
