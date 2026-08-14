# Lifecycle v1 API

The machine-facing surface. It exists so a host application — GomaAI — can drive the
reminder engine without reaching into its database and without a human in its UI.

Everything here is stable enough to build against and small enough to read in one sitting.

## Authenticating

One bearer token per integration, created in **Settings → API keys**. The raw value is shown
once; only a SHA-256 hash is stored, so a database dump yields no working tokens and "show it
to me again" is genuinely impossible — re-issue instead.

```
Authorization: Bearer lc_live_...
```

**The token is the tenant.** No endpoint takes a business id in the path, the query string or
the body, and none would honour one if it did. A caller cannot ask for another tenant's data
because there is nowhere in the request to ask. This is why the token hash is globally unique
rather than unique per business.

Unknown and revoked tokens return the same `401 invalid token`. Telling them apart would
confirm that a token was once real, which is the one bit worth probing for.

## Response envelope

Success is always `{ "ok": true, ... }`. Failure is always `{ "ok": false, "error": "..." }`,
so a caller can branch on one field without knowing which endpoint it called.

| Status | Meaning |
|---|---|
| `400` | Malformed body or an out-of-range parameter. Includes `issues[]` from schema validation. |
| `401` | Missing or invalid token. |
| `404` | No such row **for this tenant**. A row that exists under another business is a 404, not a 403 — a 403 would confirm it exists. |
| `500` | Logged in full server-side; the caller gets a stable, uninformative message. |

---

## Reading the queue

### `GET /api/v1/reminders`

The endpoint the integration exists for. Everything else manages inputs; this reads the output.

| Parameter | Notes |
|---|---|
| `view` | `due` · `upcoming` · `attention`. Preferred over `status`. |
| `status` | `queued` · `claimed` · `sent` · `failed` · `skipped`. Raw state, no time predicate. |
| `member_id` | Only reminders going to one roster member. |
| `occurring_since` / `occurring_until` | `YYYY-MM-DD`, filters on the date the reminder is *about*. |
| `expand` | `contact` — adds the client name and event type. Costs one extra round trip. |
| `limit` / `offset` | Default 50, max 200. `total` is uncapped, so `total > limit` means page. |

**Use `view=due`, not `status=queued`.** "Due" is `queued AND due_at <= now`, the same predicate
the delivery loop uses. `status=queued` also returns reminders scheduled weeks out.

`view=attention` is `failed` **or** `skipped`. `skipped` is the quiet one — it means the
reminder resolved to nobody, or the sender was not configured — and it is the reason this view
exists.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/reminders?view=due&expand=contact&limit=100"
```

```json
{
  "ok": true,
  "reminders": [{
    "id": "…", "status": "queued",
    "occurrence_date": "2026-09-01",
    "due_at": "2026-08-25T01:00:00Z",
    "suggestion": "Hi Mr Tan, just a heads-up that your policy…",
    "member_id": "…", "event_id": "…", "rule_id": "…",
    "contact": { "id": "…", "name": "Tan Wei Ming" },
    "event": { "event_type": "policy_expiry", "label": "AIA policy" }
  }],
  "total": 48, "limit": 100, "offset": 0
}
```

`suggestion` is null until delivery — it is drafted at send time, not at materialisation.

---

## Pushing data in

### `POST /api/v1/contacts` — bulk

Up to 500 contacts per call, each with up to 50 dates. Same code path as the upload wizard, so
the two cannot drift.

```json
{
  "contacts": [{
    "name": "Tan Wei Ming", "phone": "91234567",
    "email": "tan@example.com", "agent": "Jasmine Tan",
    "events": [{ "type": "policy_expiry", "date": "18/08/2026", "label": "AIA policy" }]
  }],
  "default_country_code": "+65",
  "date_format": "DD/MM/YYYY"
}
```

Two fields decide whether the import is correct, and neither is guessed:

- **`default_country_code`** completes local numbers. Omitting it on a local number is a
  rejection, not a silent assumption — guessing attaches a Singapore number to a Malaysian client.
- **`date_format`** disambiguates `03/04`. Omit it only when every date is already ISO.

**`agent` is matched by exact comparison** against the roster, after case-folding and honorific
stripping. A name matching nobody — or matching two people — does not get filed somewhere
plausible; it goes to the review queue. Read `GET /api/v1/members` first and send values you
know will match.

Contacts upsert on `(business_id, phone)`; dates upsert on
`(lead_id, event_type, event_date, label)` with `NULLS NOT DISTINCT`. Re-sending the same
payload is a no-op, so this is safe to call from an at-least-once queue.

### `POST /api/v1/contacts/{id}/events` — one client

For the single write when something changes: a policy renewed, a review booked. Same
idempotency. Unreadable dates come back in `rejected[]` rather than failing the call.

### `DELETE /api/v1/events/{id}`

Cascades to that date's reminders, **including ones already sent** — the response returns
`reminders_removed` so the count is not a surprise.

### `GET /api/v1/contacts/{id}`

One client: their dates, and the reminders still queued for them.

---

## Attribution review

### `GET /api/v1/reviews`

Rows the importer refused to guess at. Defaults to `status=pending`; `?status=all` for the
audit trail. `raw` is the row exactly as it arrived, so it can be shown to a human.

**A host app that ignores this will quietly accumulate contacts whose reminders all fall back
to the owner, with nothing anywhere saying why.** The pending count is the thing to alert on.

### `POST /api/v1/reviews/{id}/resolve`

```json
{ "member_id": "uuid-of-team-member" }   // or null to dismiss
```

Assigns the lead, then marks the review resolved — in that order, so a failure leaves it
pending rather than resolved against a lead that was never assigned. Dismissal is a real
outcome: some rows genuinely have no owner.

`resolved_by` is left null for API callers. That column references a real person, and writing
the token creator's id there would record a judgement they never made.

---

## Configuration (read-only)

### `GET /api/v1/members`

The attribution roster. Active only unless `?include_inactive=true`. These are **not login
seats** — a member is somewhere a reminder is delivered.

### `GET /api/v1/rules`

The policy the engine runs on. Read-only on purpose: a rule change is retroactive in effect
and silently alters what the next cycle materialises for every contact at once. That is an
operator decision made in a UI that can warn about it.

Worth reading when the queue is empty: rules and events join by **exact string equality on
free text**, so a typo on either side produces silence rather than an error.

---

## Deliberately absent

Named so you do not go looking:

- **No acknowledge/dismiss on a reminder.** There is no column for it. `sent` means the engine
  delivered it, not that a human acted on it. Adding this is a migration, and it is the first
  thing to add if the host wants to track follow-through.
- **No write access to rules or the roster.** See above.
- **No webhook out.** The host polls `view=due`. A push would need delivery guarantees and a
  retry story that do not exist yet.
- **No scopes.** One token can do everything in this document. Adequate for a trusted
  first-party caller; a third-party integration would need scoping first.
- **No cursor paging.** Offset paging only, which can skip or repeat a row under concurrent
  writes. The read endpoints are read-mostly, so this is a known simplification.

## Tenancy, and why it is enforced in code

These handlers use the **service-role** client. RLS is keyed on `auth.uid()`, and a token-authed
machine caller has no auth user — so RLS cannot scope it and would deny everything.

Tenancy is therefore application-enforced: `caller.businessId` comes from the token, and every
query filters on it explicitly. That is only safe if the filter is never forgotten, so
`tests/unit/api.test.ts` asserts that every route file under `api/v1` authenticates and takes
its tenant from `caller.businessId` — and that no serialiser ever emits `business_id`.
