-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  PLATFORM STAND-INS — DO NOT APPLY WHEN INTEGRATING INTO GomaAI.         ║
-- ║                                                                          ║
-- ║  Everything in this file already exists in                               ║
-- ║  jottiteam/lead-reactivation-agent. It is reproduced here, verbatim and  ║
-- ║  narrowed, so the standalone can run on its own Supabase project.        ║
-- ║                                                                          ║
-- ║  At integration you apply ONLY 20260811010000_lifecycle_events.sql.      ║
-- ║  Applying this file on top of the host would collide with every object   ║
-- ║  it defines.                                                             ║
-- ║                                                                          ║
-- ║  Source of truth for these shapes:                                       ║
-- ║    supabase/migrations/20260414000000_baseline.sql                       ║
-- ║    supabase/migrations/20260727120000_business_tenancy.sql               ║
-- ║    supabase/migrations/20260727170000_business_profile_split.sql         ║
-- ║                                                                          ║
-- ║  Narrowed deliberately: `leads` carries only the columns the add-on      ║
-- ║  touches. Every column omitted is NOT NULL-with-a-default in the host,   ║
-- ║  so an INSERT that omits it succeeds there too — which is what makes     ║
-- ║  the add-on's statements run unchanged against both.                     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── Shared trigger function ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── send_window ─────────────────────────────────────────────────────────────
-- The host enum. reminder_rules.send_window is typed by it, so the add-on
-- migration depends on this type existing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pg_type" WHERE "typname" = 'send_window') THEN
    CREATE TYPE "public"."send_window" AS ENUM ('morning', 'afternoon', 'evening');
  END IF;
END $$;

-- ── businesses ──────────────────────────────────────────────────────────────
-- The tenant. Audit-only `created_by`: the business survives its creator,
-- because membership rows own the access relationship and tenant data hangs
-- off businesses(id).

CREATE TABLE "public"."businesses" (
    "id"                     "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_by"             "uuid" REFERENCES "auth"."users"("id") ON DELETE SET NULL,
    "business_name"          "text" DEFAULT ''::"text" NOT NULL,
    "country_code"           "text" DEFAULT 'SG'::"text" NOT NULL,
    -- Load-bearing for this add-on: the materialiser converts
    -- (event_date, send_window) into a due_at in THIS zone, not the server's.
    "timezone"               "text" DEFAULT 'Asia/Singapore'::"text" NOT NULL,
    "default_language"       "text" DEFAULT 'en'::"text" NOT NULL,
    "onboarding_completed_at" timestamp with time zone,
    "created_at"             timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"             timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

CREATE TRIGGER "set_updated_at_businesses"
  BEFORE UPDATE ON "public"."businesses"
  FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

-- ── business_members ────────────────────────────────────────────────────────
-- Who can sign in. NOT the attribution roster — that is team_members, in the
-- add-on migration. See its header for why the two are separate.

CREATE TABLE "public"."business_members" (
    "business_id" "uuid" NOT NULL REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    "user_id"     "uuid" NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    "role"        "text" DEFAULT 'owner'::"text" NOT NULL,
    "created_at"  timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "business_members_pkey" PRIMARY KEY ("business_id", "user_id"),
    CONSTRAINT "business_members_role_check"
      CHECK (("role" = ANY (ARRAY['owner'::"text", 'member'::"text"]))),
    -- One business per user for now. Dropping THIS constraint is the entire
    -- schema cost of multi-business membership later.
    CONSTRAINT "business_members_user_id_key" UNIQUE ("user_id")
);

-- ── member_business_ids() ───────────────────────────────────────────────────
-- The membership predicate every policy uses. SECURITY DEFINER so it reads
-- business_members regardless of that table's own RLS; STABLE so the planner
-- caches it per statement.

CREATE OR REPLACE FUNCTION "public"."member_business_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT business_id FROM business_members WHERE user_id = auth.uid()
$$;

REVOKE ALL ON FUNCTION "public"."member_business_ids"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."member_business_ids"() TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."member_business_ids"() TO "service_role";

ALTER TABLE "public"."businesses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "businesses_member_select"
  ON "public"."businesses" FOR SELECT TO "authenticated"
  USING ("id" IN (SELECT "public"."member_business_ids"()));

ALTER TABLE "public"."business_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "business_members_self_select"
  ON "public"."business_members" FOR SELECT TO "authenticated"
  USING ("user_id" = (SELECT "auth"."uid"()));
-- No INSERT/UPDATE/DELETE policies: membership is written by the service role.

-- ── leads ───────────────────────────────────────────────────────────────────
-- A contact. Strict subset of the host's `leads`: id, business_id, name,
-- phone, email, context and the timestamps are every column the add-on reads
-- or writes. Constraint NAMES are copied verbatim, so any code that reacts to
-- a 23505 message behaves identically against both.

CREATE TABLE "public"."leads" (
    "id"          "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    "name"        "text" NOT NULL,
    "phone"       "text" NOT NULL,   -- E.164, with the leading '+'
    "email"       "text",
    -- The free-form bag. Import columns that are not mapped land here.
    "context"     "jsonb" DEFAULT '{}'::"jsonb",
    "created_at"  timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"  timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leads_pkey" PRIMARY KEY ("id"),
    -- The live upsert key. Every ingest path uses onConflict: "business_id,phone".
    CONSTRAINT "leads_business_id_phone_key" UNIQUE ("business_id", "phone"),
    -- Composite FK target, so children can enforce same-business by FK rather
    -- than by trigger. See the add-on migration.
    CONSTRAINT "leads_id_business_id_key" UNIQUE ("id", "business_id")
);

CREATE INDEX "idx_leads_business" ON "public"."leads" ("business_id");

CREATE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."leads"
  FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leads_member_select" ON "public"."leads"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));
CREATE POLICY "leads_member_insert" ON "public"."leads"
  FOR INSERT TO "authenticated"
  WITH CHECK ("business_id" IN (SELECT "public"."member_business_ids"()));
CREATE POLICY "leads_member_update" ON "public"."leads"
  FOR UPDATE TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()))
  WITH CHECK ("business_id" IN (SELECT "public"."member_business_ids"()));
CREATE POLICY "leads_member_delete" ON "public"."leads"
  FOR DELETE TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));

-- ── GRANTs ──────────────────────────────────────────────────────────────────
-- Supabase's "auto-expose new public tables to the Data API roles" default
-- flipped to false on 2026-05-30. Without explicit grants EVERY query 42501s,
-- including service_role — which bypasses RLS but still goes through PostgREST
-- and still needs table privileges.

GRANT SELECT ON TABLE "public"."businesses", "public"."business_members" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."leads" TO "authenticated";
GRANT ALL ON TABLE "public"."businesses", "public"."business_members", "public"."leads"
  TO "service_role";
