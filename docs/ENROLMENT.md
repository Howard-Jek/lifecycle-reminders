# Enrolling a customer

Self-serve signup is closed. Accounts are created by invitation.

## The control is on Supabase, not in this app

Removing the signup form does **not** close signup, and it is worth being blunt about why.
The anon key is public by design — it ships to any browser that loads the app — and GoTrue's
`POST /auth/v1/signup` accepts it from anywhere. Anyone who has read the network tab can create
an account without ever touching `src/app/actions/auth.ts`.

So the actual control is one setting:

> **Supabase dashboard → Authentication → Sign In / Providers → Email → "Allow new users to sign
> up" → OFF**

That sets `disable_signup: true`. Confirm it took:

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/settings" -H "apikey: $ANON" | grep disable_signup
```

`"disable_signup": true` is the pass condition. Until it says that, the app's UI is a sign on a
door that is not locked.

The app changes are still worth having — they stop honest people bouncing off a form that
cannot work — but they are the sign, not the lock.

## Inviting somebody

```bash
npx tsx scripts/invite-operator.ts --email new@agency.example
```

It prints a single-use link. Send it however you already talk to them.

**It deliberately does not send the email itself.** `inviteUserByEmail()` asks Supabase to send
it, and the free tier's built-in SMTP allows roughly two an hour — we hit that ceiling during
setup and spent an afternoon believing signup was broken. `generateLink()` mints the same link
and hands it back, so enrolment does not depend on a mail server at all.

It also means no password for a real person is ever typed by an operator, pasted into a chat, or
left in a terminal history. They choose their own on the page the link opens.

The invited user lands on the reminder inbox with an **empty business of their own**. The
business is not created by this script: `getTenant()` mints one on their first authenticated
request, so an invited operator, a seeded demo and any pre-membership straggler all arrive
through one code path. There is no second way for a tenant to come into existence.

## Getting them started

```bash
npx tsx scripts/seed-demo.ts --email new@agency.example
```

Adds the roster and the five starter reminder rules. Run it **after** they have signed in once —
before that there is no business to attach anything to, and the script will tell you so.

Then they import their own book at `/import`, or you push it in over
`POST /api/v1/contacts` (see [API.md](API.md)).

## Seeing who has access

```bash
npx tsx scripts/invite-operator.ts --list
```

`PENDING` means the link has not been used yet, so that person has no business.

## Removing access

```bash
npx tsx scripts/invite-operator.ts --revoke old@agency.example
```

Deletes the login. `business_members.user_id` cascades from `auth.users`, so the membership goes
with it.

**The business and every contact, date and reminder in it survive**, deliberately. Losing a
customer's book because a login was removed would be a far worse failure than an orphaned
tenant, and an orphan is recoverable — invite a replacement and point the membership at it. That
last step is manual today; there is no UI for re-attaching a tenant.

## Lost link

Re-run the invite. The script notices the account exists and mints a magic link instead of an
invite link, which is the same thing from the recipient's side. `invite` fails against an
existing user, so without that branch the "lost my link" case would be unserviceable.
