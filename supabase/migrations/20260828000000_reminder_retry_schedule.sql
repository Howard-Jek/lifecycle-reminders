-- When a failed reminder may be attempted again.
--
-- Retry was already here: a failed send returned to 'queued' and the next tick
-- collected it. What was missing is the WAIT — the interval was whatever the
-- scheduler's period happened to be, so it changed silently when the driver
-- changed. Holding it on the row makes the schedule a property of the work
-- rather than of whoever happens to be calling the cycle.
--
-- NULL means "eligible now". That is every row today and every first attempt
-- forever, which is why there is no default beyond NULL and no backfill: a
-- queue that has never failed has nothing to wait for.
ALTER TABLE "public"."reminders"
  ADD COLUMN "next_attempt_at" timestamp with time zone;

COMMENT ON COLUMN "public"."reminders"."next_attempt_at" IS
  'Earliest instant this reminder may be attempted again. NULL = eligible now.';

-- The delivery query's hot path gained a predicate, and the partial index that
-- made the queue fast no longer covered it. Rebuilt rather than added alongside:
-- two overlapping partial indexes on the same predicate is storage and write
-- cost for one query plan.
DROP INDEX IF EXISTS "public"."idx_reminders_due";
CREATE INDEX "idx_reminders_due"
  ON "public"."reminders" ("due_at", "next_attempt_at")
  WHERE ("status" = 'queued'::"text");
