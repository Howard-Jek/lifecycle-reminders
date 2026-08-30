-- Count event types in the database instead of in Node.
--
-- Two functions needed the same fact — which event types does this business
-- use, and how many dates carry each — and both got it by selecting up to
-- 10,000 rows of contact_events and reducing them in JavaScript. Measured on
-- live data: 672 rows transferred, TWICE per page render, to produce THREE
-- distinct strings. Around 660ms of the reminders page was spent moving a
-- column across the wire so it could be counted at the other end.
--
-- It also carried a silent correctness bug. Both callers capped at 10,000 rows,
-- so a business past that ceiling would simply stop seeing some of its own
-- event types — no error, no warning, just a coverage banner that quietly
-- misses a gap and a dropdown missing an option. An aggregate has no such cap.

CREATE OR REPLACE FUNCTION "public"."event_type_counts"("p_business_id" "uuid")
RETURNS TABLE ("event_type" "text", "count" bigint)
LANGUAGE "sql"
STABLE
-- SECURITY INVOKER: the caller's own privileges apply, so this cannot be used
-- to read another tenant's rows. RLS on contact_events still governs, and the
-- service-role callers pass the business id explicitly.
SECURITY INVOKER
SET "search_path" = ''
AS $$
  SELECT e."event_type", COUNT(*)::bigint
    FROM "public"."contact_events" e
   WHERE e."business_id" = "p_business_id"
   GROUP BY e."event_type"
   ORDER BY COUNT(*) DESC, e."event_type";
$$;

REVOKE ALL ON FUNCTION "public"."event_type_counts"("uuid") FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."event_type_counts"("uuid") TO "authenticated", "service_role";

COMMENT ON FUNCTION "public"."event_type_counts"("uuid") IS
  'Distinct event types for one business with their counts. Replaces two 10k-row client-side scans that shared the same purpose and the same silent 10k ceiling.';
