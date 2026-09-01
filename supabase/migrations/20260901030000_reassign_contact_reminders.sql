-- Move a contact's unsent reminders when its agent changes.
--
-- RENAMED from 20260831080000, where it lives on
-- claude/whatsapp-webhook-validation-tswrys, so it sorts after the migrations
-- already applied to the live database. CREATE OR REPLACE FUNCTION is
-- idempotent, so merging that branch later re-runs it harmlessly.
--
-- assignContact updated leads.assigned_member_id and stopped there, but
-- deliverOne resolves the recipient from reminders.member_id — the value
-- stamped on the row when it was materialised, not the contact's current
-- assignment. So every reminder already queued for a reassigned contact went
-- on being delivered to the PREVIOUS agent, indefinitely, with the contact
-- page showing the new one. Nothing in the send path re-reads the assignment,
-- so nothing corrected it.
--
-- WHY A FUNCTION. Three things have to be true together or not at all: only
-- `assigned`-audience rows move, at most one row may end up holding any given
-- (event, rule, occurrence) for the new agent, and the rest have to be
-- resolved rather than left dangling. Done as four PostgREST round trips this
-- is a read-then-write race against the scheduler, which claims rows every
-- fifteen minutes; as one statement it is atomic.
--
-- WHAT IS DELIBERATELY LEFT ALONE:
--
--   all_members rules. Their rows are a fan-out — one per active agent, which
--   is what member_id is doing in the identity key. They have nothing to do
--   with who the contact is assigned to, and moving them would both be wrong
--   and collide with the new agent's own row.
--
--   sent, failed and skipped. Those record what happened, and it happened to
--   the old agent. Rewriting them would falsify history to tidy a list.
--
-- WHAT IS NOT LEFT ALONE, AND WHY: `claimed`. A claimed row is one a worker
-- holds mid-send, so moving it can leave the record naming the new agent when
-- the old agent's handset got the message — a window of seconds. Excluding it
-- costs more: a worker that dies leaves the claim standing for thirty minutes
-- (requeueStuckClaims), and the requeue does not touch member_id, so the row
-- returns to the queue still addressed to the old agent and is delivered
-- there. A stale record on a seconds-long window beats a wrong delivery on a
-- half-hour one.

CREATE OR REPLACE FUNCTION "public"."reassign_contact_reminders"(
  "p_business_id" "uuid",
  "p_lead_id"     "uuid",
  "p_member_id"   "uuid"
)
RETURNS TABLE ("moved" bigint, "superseded" bigint)
LANGUAGE "sql"
VOLATILE
-- SECURITY INVOKER, as with every function here: the caller's own privileges
-- apply, so this cannot reach another tenant's rows. The business id is passed
-- explicitly and every branch below is scoped by it.
SECURITY INVOKER
SET "search_path" = ''
AS $$
WITH "scoped" AS (
  SELECT r."id", r."event_id", r."rule_id", r."occurrence_date",
         -- Reassignment history can leave two agents holding rows with the
         -- same identity; moving both would violate reminders_identity_key and
         -- abort the whole update. One wins, deterministically, and the losers
         -- are resolved below — they would be a duplicate message to the same
         -- agent, which is exactly what that key exists to prevent.
         "row_number"() OVER (
           PARTITION BY r."event_id", r."rule_id", r."occurrence_date"
           ORDER BY r."created_at", r."id"
         ) AS "rn"
    FROM "public"."reminders" r
    JOIN "public"."contact_events" e
      ON e."id" = r."event_id" AND e."business_id" = r."business_id"
    JOIN "public"."reminder_rules" ru
      ON ru."id" = r."rule_id" AND ru."business_id" = r."business_id"
   WHERE r."business_id" = "p_business_id"
     AND e."lead_id" = "p_lead_id"
     AND ru."audience" = 'assigned'
     AND r."status" IN ('queued', 'claimed')
     -- Already pointing at the new agent: nothing to do, and excluding it here
     -- keeps it from matching itself in "taken" below.
     AND r."member_id" IS DISTINCT FROM "p_member_id"
),
"plan" AS (
  SELECT s."id",
         (
           s."rn" = 1
           AND NOT EXISTS (
             -- The new agent already holds this exact reminder — most often a
             -- `sent` row from before the contact was moved away and back.
             -- NOT DISTINCT FROM, because the identity key is NULLS NOT
             -- DISTINCT and NULL here is the real unassigned/owner-fallback
             -- recipient rather than a missing value.
             SELECT 1
               FROM "public"."reminders" x
              WHERE x."event_id" = s."event_id"
                AND x."rule_id" = s."rule_id"
                AND x."occurrence_date" = s."occurrence_date"
                AND x."member_id" IS NOT DISTINCT FROM "p_member_id"
           )
         ) AS "movable"
    FROM "scoped" s
),
"moved" AS (
  UPDATE "public"."reminders" u
     SET "member_id" = "p_member_id"
    FROM "plan" p
   WHERE u."id" = p."id" AND p."movable"
  RETURNING u."id"
),
"superseded" AS (
  -- Resolved, not deleted. These rows are evidence that something was queued,
  -- and the reason is the sort of thing an operator reads once and never has
  -- to ask about again.
  UPDATE "public"."reminders" u
     SET "status" = 'skipped',
         "error"  = 'superseded when the contact''s agent changed'
    FROM "plan" p
   WHERE u."id" = p."id" AND NOT p."movable"
  RETURNING u."id"
)
SELECT (SELECT COUNT(*) FROM "moved")::bigint,
       (SELECT COUNT(*) FROM "superseded")::bigint;
$$;

REVOKE ALL ON FUNCTION "public"."reassign_contact_reminders"("uuid", "uuid", "uuid")
  FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."reassign_contact_reminders"("uuid", "uuid", "uuid")
  TO "authenticated", "service_role";

COMMENT ON FUNCTION "public"."reassign_contact_reminders"("uuid", "uuid", "uuid") IS
  'Point a contact''s unsent assigned-audience reminders at a new agent, atomically. Leaves all_members fan-out and terminal rows alone; resolves rows the new agent already holds as skipped rather than colliding with reminders_identity_key.';
