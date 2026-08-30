-- A record that the engine ran.
--
-- The reminder inbox has always shown reminders as "Due" without being able to
-- say whether anything would ever collect them. That was survivable while a
-- scheduler was always running; it stopped being survivable the moment both
-- schedulers were switched off, because the screen then reads exactly the same
-- as a healthy one — a queue with due items and no explanation of the silence.
--
-- Deliberately OBSERVED rather than declared. A config flag saying "sending is
-- on" is a claim about a cron in a different system, and it would go stale the
-- first time someone disabled the workflow without editing an env var. A row
-- written by the cycle itself cannot lie about whether the cycle ran.

CREATE TABLE "public"."scheduler_runs" (
    "id"           "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ran_at"       timestamp with time zone DEFAULT "now"() NOT NULL,
    -- What the run did, so a run that fired and achieved nothing is
    -- distinguishable from one that never fired.
    "materialised" integer DEFAULT 0 NOT NULL,
    "sent"         integer DEFAULT 0 NOT NULL,
    "failed"       integer DEFAULT 0 NOT NULL,
    "skipped"      integer DEFAULT 0 NOT NULL,
    -- 'cron' | 'github' | 'manual' — which driver, since there are three.
    "source"       "text",

    CONSTRAINT "scheduler_runs_pkey" PRIMARY KEY ("id")
);

-- The only query: "when did this last run?"
CREATE INDEX "scheduler_runs_ran_at_idx" ON "public"."scheduler_runs" ("ran_at" DESC);

ALTER TABLE "public"."scheduler_runs" ENABLE ROW LEVEL SECURITY;

-- Deployment-wide, not per-tenant: one engine serves every business, so there
-- is no business_id to key a policy on. Every signed-in member may read it —
-- "is the engine running" is not a tenant secret, and withholding it is what
-- produced the silence this table exists to explain.
CREATE POLICY "scheduler_runs_member_select"
  ON "public"."scheduler_runs" FOR SELECT TO "authenticated" USING (true);

GRANT SELECT ON TABLE "public"."scheduler_runs" TO "authenticated";
GRANT ALL    ON TABLE "public"."scheduler_runs" TO "service_role";
REVOKE ALL   ON TABLE "public"."scheduler_runs" FROM "anon";

COMMENT ON TABLE "public"."scheduler_runs" IS
  'One row per reminder cycle. Lets the UI say whether automatic sending is actually running, rather than trusting a config flag about a cron in another system.';
