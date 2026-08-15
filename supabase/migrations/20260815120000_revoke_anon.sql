-- Make "anon is granted nothing" true, rather than merely intended.
--
-- 20260811010000_lifecycle_events.sql says, in its GRANTs block:
--
--     `anon` is granted nothing, anywhere. No browser code reads any of these
--     tables unauthenticated, so a grant would buy nothing and leave the secret
--     tables one dropped policy away from exposure.
--
-- The intent was right and the implementation was absent. That block GRANTs to
-- `authenticated` and `service_role` and never REVOKEs from `anon`, so on a
-- project whose default privileges hand new public tables to the Data API roles
-- — which is where these tables were created — `anon` quietly holds them.
--
-- Observed on the live database, unauthenticated, with the public anon key:
--
--   businesses, business_members, leads, team_members, contact_events,
--   reminder_rules, reminders, contact_imports, contact_import_reviews,
--   sandbox_messages          → HTTP 200 (empty array)
--   contact_ingest_tokens,
--   team_member_calendar_tokens → HTTP 401 permission denied
--
-- The two 401s are the tables the migration REVOKEs explicitly. The ten 200s
-- are the tables it does not. That difference is the grant: an empty array
-- means the query RAN and RLS returned no rows, where a missing grant would
-- have refused it outright.
--
-- Nothing is exposed today, because every one of those ten carries an RLS
-- policy keyed on member_business_ids() and there is no unauthenticated path
-- through it. The problem is that RLS is then the ONLY layer. One dropped or
-- mis-edited policy — on a table holding client names, phone numbers and the
-- drafted message text — becomes a full public read with nothing behind it.
-- Defence in depth is exactly the thing you do not notice is missing until it
-- is the only thing that would have helped.
--
-- SAFE TO APPLY: nothing in this application reads a table as `anon`.
-- src/lib/supabase/client.ts (the browser client) was deleted; every server
-- read goes through the user's own JWT, which is role `authenticated`; and the
-- one unauthenticated page, the landing page, calls auth.getUser() against
-- GoTrue and touches no table at all.

-- ── The ten tenant tables ───────────────────────────────────────────────────
REVOKE ALL ON TABLE "public"."businesses"              FROM "anon";
REVOKE ALL ON TABLE "public"."business_members"        FROM "anon";
REVOKE ALL ON TABLE "public"."leads"                   FROM "anon";
REVOKE ALL ON TABLE "public"."team_members"            FROM "anon";
REVOKE ALL ON TABLE "public"."contact_events"          FROM "anon";
REVOKE ALL ON TABLE "public"."reminder_rules"          FROM "anon";
REVOKE ALL ON TABLE "public"."reminders"               FROM "anon";
REVOKE ALL ON TABLE "public"."contact_imports"         FROM "anon";
REVOKE ALL ON TABLE "public"."contact_import_reviews"  FROM "anon";

-- Created by the standalone-only sandbox migration, and subject to the same
-- default. Guarded because the sandbox migration is NOT applied when this
-- schema is merged into the host app.
DO $$
BEGIN
  IF to_regclass('public.sandbox_messages') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE "public"."sandbox_messages" FROM "anon"';
  END IF;
END $$;

-- ── Stop the next table inheriting the same thing ───────────────────────────
--
-- The REVOKEs above fix the tables that exist. This fixes the ones that do not
-- yet: without it, the next migration to CREATE TABLE re-acquires the default
-- and this file has to be written again. Scoped to the role that owns the
-- schema, which is what the default privileges are attached to.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";

-- ── The helper function ─────────────────────────────────────────────────────
--
-- 20260811000000_platform_standins.sql REVOKEs this FROM PUBLIC and grants it
-- to `authenticated` and `service_role`. `anon` was still able to execute it on
-- the live database, which means the grant arrived from somewhere other than
-- that migration. It is SECURITY DEFINER and reads business_members, so an
-- anonymous caller could invoke it; it returns nothing useful without an
-- auth.uid(), but a SECURITY DEFINER function reachable by an anonymous role is
-- not a thing to leave lying around.
REVOKE ALL ON FUNCTION "public"."member_business_ids"() FROM "anon";

-- ── Verify ──────────────────────────────────────────────────────────────────
--
-- Run this after applying. Every row it returns is a grant that should not
-- exist; an empty result is the pass condition.
--
--   SELECT table_name, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE grantee = 'anon' AND table_schema = 'public'
--    ORDER BY table_name, privilege_type;
--
-- And from the outside, with the public anon key, every one of these should
-- answer 401 rather than 200:
--
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--     "$SUPABASE_URL/rest/v1/leads?select=id&limit=1"
