-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  PLATFORM STAND-IN — DO NOT APPLY WHEN INTEGRATING INTO GomaAI.          ║
-- ║                                                                          ║
-- ║  `businesses.vertical` already exists in                                 ║
-- ║  jottiteam/lead-reactivation-agent. Reproduced here, verbatim, so the     ║
-- ║  standalone can resolve a reminder pack the same way the host will.      ║
-- ║                                                                          ║
-- ║  Source of truth for this shape:                                         ║
-- ║    supabase/migrations/20260727170000_business_profile_split.sql         ║
-- ║    supabase/migrations/20260812090000_add_other_vertical.sql             ║
-- ║                                                                          ║
-- ║  A separate file rather than an edit to 20260811000000_platform_standins ║
-- ║  because that one has already been applied; editing it would not re-run. ║
-- ║                                                                          ║
-- ║  scripts/sql-bundle.ts selects the add-on bundle by the literal string    ║
-- ║  "lifecycle_events" in the filename, so this is excluded from it          ║
-- ║  automatically and included in the full bundle. No script change.        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- NULLABLE WITH NO DEFAULT, matching the host exactly.
--
-- NULL means "not chosen yet", which is a real and common state: the host's
-- onboarding asks for the industry in its profile step, and a business exists
-- before that step is done. It is not the same as 'other', which is a positive
-- answer meaning "none of these fit".
--
-- The pack resolver treats both as the generic pack, but only NULL is a
-- question that has not been asked.
ALTER TABLE "public"."businesses"
  ADD COLUMN IF NOT EXISTS "vertical" "text";

-- The twelve values, copied from the host's constraint as widened by
-- 20260812090000_add_other_vertical.sql. A CHECK rather than an enum because
-- that is what the host uses: adding a vertical there is an ALTER of this
-- constraint, and a Postgres enum would make it a type migration instead.
--
-- Kept in the DECLARATION order of the host's VERTICALS array, not
-- alphabetically. Display order is a UI concern and lives in the picker.
ALTER TABLE "public"."businesses"
  DROP CONSTRAINT IF EXISTS "businesses_vertical_check";
ALTER TABLE "public"."businesses"
  ADD CONSTRAINT "businesses_vertical_check"
  CHECK (("vertical" IS NULL) OR ("vertical" = ANY (ARRAY[
    'mortgage'::"text",
    'insurance'::"text",
    'financial_advisory'::"text",
    'real_estate'::"text",
    'dental'::"text",
    'beauty'::"text",
    'construction'::"text",
    'fitness'::"text",
    'home_services'::"text",
    'saas'::"text",
    'training'::"text",
    'other'::"text"
  ])));

COMMENT ON COLUMN "public"."businesses"."vertical" IS
  'The operator''s industry. Selects the lifecycle reminder pack; see src/lib/lifecycle/vertical-packs.ts. NULL = not chosen yet.';
