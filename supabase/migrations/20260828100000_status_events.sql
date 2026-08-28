-- Every delivery receipt Meta sends, kept.
--
-- The webhook has always ACTED on `failed` and discarded `sent`, `delivered`
-- and `read` — there was nowhere to put them and no screen showing them. That
-- looked like restraint and was actually a blind spot: for three days a message
-- could be accepted with a real id, never arrive, and leave no trace anywhere
-- to say whether Meta had reported anything at all. "No receipt" and "delivered
-- fine" were indistinguishable from inside the system.
--
-- Keeping them costs one narrow row per status transition and turns that
-- question into a query. It is also the honest basis for a delivery view later:
-- an agent asking "did they get it?" is asking about `read`, not about whether
-- an HTTP call succeeded.

CREATE TABLE "public"."whatsapp_status_events" (
    "id"          "uuid" DEFAULT "gen_random_uuid"() NOT NULL,

    -- Meta's message id. NOT unique: one message legitimately produces sent,
    -- then delivered, then read, and the sequence is the useful part.
    "wamid"       "text" NOT NULL,
    "status"      "text" NOT NULL,
    -- Meta's failure detail, already flattened. NULL for the happy states.
    "error"       "text",
    -- Who it was going to, as Meta reports it (E.164 without the "+").
    "recipient"   "text",

    -- Set when the wamid matches a reminder we sent. NULL for test sends and
    -- for anything else that went out outside the queue.
    "reminder_id" "uuid",
    "business_id" "uuid",

    "occurred_at" timestamp with time zone,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "whatsapp_status_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_status_events_reminder_id_fkey" FOREIGN KEY ("reminder_id")
      REFERENCES "public"."reminders"("id") ON DELETE SET NULL,
    CONSTRAINT "whatsapp_status_events_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE
);

-- The two questions asked of this table: "what happened to this message" and
-- "what has been happening lately".
CREATE INDEX "whatsapp_status_events_wamid_idx"
  ON "public"."whatsapp_status_events" ("wamid", "received_at" DESC);
CREATE INDEX "whatsapp_status_events_received_idx"
  ON "public"."whatsapp_status_events" ("received_at" DESC);

ALTER TABLE "public"."whatsapp_status_events" ENABLE ROW LEVEL SECURITY;

-- Members read their own tenant's receipts. Rows with a NULL business_id — a
-- receipt for a message that matches no reminder — are readable by nobody
-- through RLS, which is correct: they belong to no tenant.
CREATE POLICY "whatsapp_status_events_member_select"
  ON "public"."whatsapp_status_events"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));

GRANT SELECT ON TABLE "public"."whatsapp_status_events" TO "authenticated";
GRANT ALL    ON TABLE "public"."whatsapp_status_events" TO "service_role";
REVOKE ALL   ON TABLE "public"."whatsapp_status_events" FROM "anon";

COMMENT ON TABLE "public"."whatsapp_status_events" IS
  'Every delivery receipt from Meta. Written only by the webhook, as service_role. business_id is NULL when the wamid matches no reminder.';
