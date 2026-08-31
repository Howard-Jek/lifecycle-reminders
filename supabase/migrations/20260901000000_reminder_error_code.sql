-- Meta's failure code, kept as a column instead of only inside a sentence.
--
-- `reminders.error` already carries the reason, flattened by describeErrors to
-- a line like "[131047] Re-engagement message". That reads well and is useless
-- to query: "how many 131047s this week", "is this number permanently bad or
-- was it a rate limit" and "may this be retried" are all questions about the
-- CODE, and the code was only ever a prefix inside prose.
--
-- It matters most for the retry decision. Retrying 131026 — the handset is not
-- on WhatsApp — burns three billed sends against a number that will never
-- receive one, while 130429 is a rate limit that wants exactly the opposite
-- treatment. Deciding that by pattern-matching an error string is how you ship
-- a retry policy that quietly does the wrong thing on the day the wording
-- changes.
--
-- Nullable throughout: Meta does not always send a code, older rows have none,
-- and a failure with no code is still a failure. No CHECK — the code space is
-- Meta's, it grows without telling us, and a constraint here would turn "Meta
-- shipped a new code" into a failed webhook write.
--
-- THIS MIGRATION IS MEANT FOR THE HOST. Like 20260828100000_status_events.sql,
-- it applies as-is when integrating into GomaAI.

ALTER TABLE "public"."reminders"
  ADD COLUMN IF NOT EXISTS "error_code" "text";

ALTER TABLE "public"."whatsapp_status_events"
  ADD COLUMN IF NOT EXISTS "error_code" "text";

COMMENT ON COLUMN "public"."reminders"."error_code" IS
  'Meta error code for the failure in `error`, when Meta gave one. Drives the retry decision; see src/lib/whatsapp-errors.ts.';

COMMENT ON COLUMN "public"."whatsapp_status_events"."error_code" IS
  'Meta error code as delivered on the receipt. Kept alongside the flattened `error` so failures can be counted by cause.';

-- Answers "what has been failing, and why" without a scan. Partial, because
-- the happy receipts vastly outnumber the failures and none of them have a
-- code to group by.
CREATE INDEX IF NOT EXISTS "whatsapp_status_events_error_code_idx"
  ON "public"."whatsapp_status_events" ("error_code", "received_at" DESC)
  WHERE ("error_code" IS NOT NULL);
