-- Somewhere for replies to land.
--
-- Every message this product sends goes TO an agent, from one platform number.
-- Agents reply to it — that is what a human does when a message arrives — and
-- until now those replies hit the webhook and went nowhere. A "receive" URL
-- that discards what it receives is not receiving, and the messages are not
-- recoverable afterwards: Meta does not let you re-fetch a webhook payload.

CREATE TABLE "public"."whatsapp_inbound_messages" (
    "id"             "uuid" DEFAULT "gen_random_uuid"() NOT NULL,

    -- Meta's message id. UNIQUE is the whole idempotency story: Meta retries a
    -- payload until it gets a 2xx, and at-least-once delivery means the same
    -- reply WILL arrive twice. An ON CONFLICT DO NOTHING against this
    -- constraint is what makes the retry harmless.
    "wamid"          "text" NOT NULL,

    -- Resolved from team_members.whatsapp_number, and NULLABLE on purpose.
    -- A message from a number not on any roster is the interesting case — a
    -- wrong number, a client who somehow has the platform number, an agent
    -- texting from their personal handset — and dropping it because it does not
    -- belong to a tenant would discard exactly the rows worth looking at.
    "business_id"    "uuid",
    "team_member_id" "uuid",

    -- E.164 WITHOUT the leading "+", which is the form Meta sends.
    "from_number"    "text" NOT NULL,
    "message_type"   "text" NOT NULL,
    -- NULL for media, location, and anything whose content is not text.
    "body"           "text",

    "sent_at"        timestamp with time zone,
    "received_at"    timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "whatsapp_inbound_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_inbound_messages_wamid_key" UNIQUE ("wamid"),
    CONSTRAINT "whatsapp_inbound_messages_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    -- SET NULL, not CASCADE: removing somebody from the roster must not delete
    -- what they said. The business_id survives, so the message stays readable.
    CONSTRAINT "whatsapp_inbound_messages_team_member_id_fkey" FOREIGN KEY ("team_member_id")
      REFERENCES "public"."team_members"("id") ON DELETE SET NULL
);

-- The only query anyone runs against this: newest first, for one tenant.
CREATE INDEX "whatsapp_inbound_messages_business_received_idx"
  ON "public"."whatsapp_inbound_messages" ("business_id", "received_at" DESC);

ALTER TABLE "public"."whatsapp_inbound_messages" ENABLE ROW LEVEL SECURITY;

-- Same shape as every other tenant table. Read-only for members; the webhook
-- writes as service_role, which bypasses RLS, so there is no INSERT policy to
-- write and no path for a browser to forge an inbound message.
CREATE POLICY "whatsapp_inbound_messages_member_select"
  ON "public"."whatsapp_inbound_messages"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));

GRANT SELECT ON TABLE "public"."whatsapp_inbound_messages" TO "authenticated";
GRANT ALL    ON TABLE "public"."whatsapp_inbound_messages" TO "service_role";
-- Belt and braces. 20260815120000_revoke_anon.sql set ALTER DEFAULT PRIVILEGES
-- so new tables no longer reach `anon`, but that default is attached to the
-- role that ran it — stating it here means this table is correct even if the
-- migration is replayed into a project where that never happened.
REVOKE ALL ON TABLE "public"."whatsapp_inbound_messages" FROM "anon";

COMMENT ON TABLE "public"."whatsapp_inbound_messages" IS
  'Replies to the platform WhatsApp number. Written only by the webhook, as service_role. business_id is NULL when the sender matches no roster number.';
