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

-- NO INDEX CHANGE, deliberately — and this comment used to claim the opposite.
--
-- The obvious move is to widen idx_reminders_due to (due_at, next_attempt_at).
-- It buys nothing. The delivery query asks for
-- `next_attempt_at IS NULL OR next_attempt_at <= now()`, and Postgres cannot
-- turn an OR into a btree index condition. Measured on 16.13 against 150k
-- queued rows, the plan is byte-identical either way — `Index Cond: (due_at <=
-- now())` with next_attempt_at evaluated as a heap Filter — and buffers go UP,
-- because the index is wider for no extra selectivity. It stays a Filter even
-- with next_attempt_at as the LEADING column.
--
-- The rebuild is not free, either: DROP + CREATE takes an ACCESS EXCLUSIVE lock
-- that blocks reads AND writes on `reminders` for the whole build, and this
-- migration is applied to populated databases — scripts/sql-bundle.ts ships it
-- to the host deliberately. A metadata-only ADD COLUMN becomes a blocking DDL
-- to achieve nothing.
--
-- The existing (due_at) partial index already covers the boundary condition and
-- the ORDER BY, which is everything a btree can contribute to this predicate.
-- Making the column NOT NULL DEFAULT now() WOULD make it sargable, but it costs
-- a backfill and gives up "NULL = eligible now" — a poor trade for a clause that
-- discards a handful of rows from a 40-row page.
