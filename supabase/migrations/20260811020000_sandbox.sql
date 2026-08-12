-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SANDBOX — DO NOT APPLY WHEN INTEGRATING INTO GomaAI.                    ║
-- ║                                                                          ║
-- ║  A message log that lets the whole product be demonstrated before the    ║
-- ║  WhatsApp number and the approved template exist.                        ║
-- ║                                                                          ║
-- ║  It is NOT a mock. The rows here are written by the real delivery path   ║
-- ║  in src/lib/lifecycle/run-cycle.ts — same materialiser, same claim, same ║
-- ║  five template params. The only thing the sandbox replaces is the final  ║
-- ║  Graph API POST. So what you see in /sandbox is what Meta would have     ║
-- ║  been asked to send, character for character.                            ║
-- ║                                                                          ║
-- ║  Deleting this file and src/lib/sandbox/ removes the whole feature; the  ║
-- ║  recorder is best-effort and swallows a missing table, so nothing in the ║
-- ║  delivery path depends on it.                                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE "public"."sandbox_messages" (
    "id"          "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,

    -- Roles rather than a direction flag. "Inbound" is ambiguous once there are
    -- two handsets in play — a message leaving the agent is arriving at the
    -- client — so each row says who sent it and who received it, and each pane
    -- works out its own left/right from that.
    "from_role"   "text" NOT NULL,
    "to_role"     "text" NOT NULL,
    "to_number"   "text",

    "body"        "text" NOT NULL,
    -- Set only for template sends. The params are kept verbatim so the sandbox
    -- can show the five positional values exactly as Meta would receive them,
    -- which is the thing worth checking before the template goes for review.
    "template_name"   "text",
    "template_params" "jsonb",

    -- What this message came from, when it came from the engine. Nullable
    -- because a hand-typed sandbox message has no reminder behind it.
    "reminder_id" "uuid",
    "lead_id"     "uuid",

    "created_at"  timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "sandbox_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sandbox_messages_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    -- ON DELETE SET NULL, not CASCADE: clearing the reminder queue must not
    -- silently erase the transcript of a demo that has already been given.
    CONSTRAINT "sandbox_messages_reminder_fkey" FOREIGN KEY ("reminder_id")
      REFERENCES "public"."reminders"("id") ON DELETE SET NULL,
    CONSTRAINT "sandbox_messages_lead_fkey" FOREIGN KEY ("lead_id", "business_id")
      REFERENCES "public"."leads"("id", "business_id") ON DELETE SET NULL ("lead_id"),
    CONSTRAINT "sandbox_messages_from_role_check"
      CHECK (("from_role" = ANY (ARRAY['system'::"text", 'agent'::"text", 'client'::"text"]))),
    CONSTRAINT "sandbox_messages_to_role_check"
      CHECK (("to_role" = ANY (ARRAY['agent'::"text", 'client'::"text"]))),
    -- template_name and template_params travel together or not at all.
    CONSTRAINT "sandbox_messages_template_coherent"
      CHECK ((("template_name" IS NULL) AND ("template_params" IS NULL))
          OR (("template_name" IS NOT NULL) AND ("template_params" IS NOT NULL)))
);

-- The transcript is always read as "this business, newest last".
CREATE INDEX "idx_sandbox_messages_business"
  ON "public"."sandbox_messages" ("business_id", "created_at");

ALTER TABLE "public"."sandbox_messages" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sandbox_messages_member_select" ON "public"."sandbox_messages"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));

-- Same reason as every other table here: auto-expose to the Data API roles has
-- been off since 2026-05-30, so without these even service_role gets 42501.
GRANT SELECT ON TABLE "public"."sandbox_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."sandbox_messages" TO "service_role";

COMMENT ON TABLE "public"."sandbox_messages" IS
  'Standalone-only. Transcript of what the real delivery path would have sent, so the product can be demonstrated before a WhatsApp number exists.';
