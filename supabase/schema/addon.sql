-- LIFECYCLE — the migrations that merge into GomaAI.
--
-- This is the piece that goes into an EXISTING GomaAI database. It
-- expects businesses, business_members, leads, member_business_ids()
-- and update_updated_at() to already exist, and it expects
-- businesses.vertical — the host already has that column.
--
-- Excluded, deliberately: the platform stand-ins, the sandbox, the
-- anon revocation and the vertical stand-in. See STANDALONE_ONLY in
-- scripts/sql-bundle.ts for why each one is left out.


-- ══════════════════════════════════════════════════════════════════════════
-- 20260811010000_lifecycle_events.sql
-- ══════════════════════════════════════════════════════════════════════════

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  LIFECYCLE REMINDERS — THE INTEGRATION ARTEFACT.                         ║
-- ║                                                                          ║
-- ║  This file applies verbatim to jottiteam/lead-reactivation-agent. It     ║
-- ║  depends on host objects only — businesses, business_members, leads,     ║
-- ║  member_business_ids(), update_updated_at(), public.send_window,         ║
-- ║  auth.users — and creates no new functions and no new types, because     ║
-- ║  every function and type name is collision surface at integration.       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A GENERIC temporal-triggers engine:
--
--   date-bearing events on contacts  ×  per-tenant reminder rules
--     → a materialised reminder queue  →  reliable delivery to the right human
--
-- Insurance policy-expiry and birthday reminders are the first PLAYBOOK, not
-- the feature: `event_type` is text, not an enum, so warranty expiries, visa
-- renewals, course start dates and subscription anniversaries are rows, not
-- code.
--
-- Every reminder goes to an AGENT. Nothing here ever messages a client — a
-- human always stands between the suggestion and the lead.

-- ── team_members ────────────────────────────────────────────────────────────
--
-- The attribution roster: who a client belongs to, and which number that
-- person's reminders are delivered TO. Deliberately NOT business_members.
--
-- business_members is the login roster — user_id is NOT NULL against
-- auth.users and carries UNIQUE(user_id), one business per user. An
-- attribution target is not a seat: a part-time agent who should receive a
-- WhatsApp but never sign in cannot exist there at all, and a CSV of ten
-- agents would become ten provisioned auth accounts. So the add-on owns one
-- roster for attribution, business_members stays purely "who can sign in",
-- and `auth_user_id` is the optional link between them.
--
-- `role` here is a ROSTER role (who is the fallback recipient), not an access
-- role. Access is business_members.role.

CREATE TABLE "public"."team_members" (
    "id"              "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id"     "uuid" NOT NULL,
    "display_name"    "text" NOT NULL,
    "email"           "text",
    -- E.164. The number reminders are delivered TO; never used to send FROM.
    "whatsapp_number" "text" NOT NULL,
    "role"            "text" DEFAULT 'agent'::"text" NOT NULL,
    -- Optional seat link. NULL = roster-only member with no login, which is
    -- the normal case.
    "auth_user_id"    "uuid",
    "active"          boolean DEFAULT true NOT NULL,
    "created_at"      timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"      timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "team_members_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    -- Composite target so every child enforces same-business by FK.
    CONSTRAINT "team_members_id_business_id_key" UNIQUE ("id", "business_id"),
    -- A linked seat must be a member of THIS business. MATCH SIMPLE, so the
    -- check is skipped entirely while auth_user_id IS NULL.
    -- Column-list SET NULL (PG15+) unlinks the roster row when the seat is
    -- revoked; a bare ON DELETE SET NULL would try to null the NOT NULL
    -- business_id alongside it and abort with 23502.
    CONSTRAINT "team_members_seat_fkey"
      FOREIGN KEY ("business_id", "auth_user_id")
      REFERENCES "public"."business_members"("business_id", "user_id")
      ON DELETE SET NULL ("auth_user_id"),
    CONSTRAINT "team_members_role_check"
      CHECK (("role" = ANY (ARRAY['owner'::"text", 'agent'::"text"]))),
    CONSTRAINT "team_members_display_name_not_blank"
      CHECK (("length"("btrim"("display_name")) > 0)),
    CONSTRAINT "team_members_business_id_whatsapp_number_key"
      UNIQUE ("business_id", "whatsapp_number")
);

-- One seat maps to at most one roster row.
CREATE UNIQUE INDEX "idx_team_members_seat"
  ON "public"."team_members" ("business_id", "auth_user_id")
  WHERE ("auth_user_id" IS NOT NULL);
CREATE INDEX "idx_team_members_business" ON "public"."team_members" ("business_id");
CREATE INDEX "idx_team_members_business_active"
  ON "public"."team_members" ("business_id") WHERE "active";

CREATE TRIGGER "set_updated_at_team_members" BEFORE UPDATE ON "public"."team_members"
  FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

-- ── team_member_calendar_tokens ─────────────────────────────────────────────
--
-- A member's ICS feed credential.
--
-- Separate table because RLS is row-level, not column-level: any SELECT policy
-- on team_members would hand every colleague every other colleague's token via
-- a plain select('*'), and that token grants unauthenticated, unexpiring read
-- of that member's whole feed — client names and dates.
--
-- Hashed because a bearer token in a URL is the only option here (calendar
-- clients send no auth headers and cannot do OAuth), so it must be
-- unguessable, revocable, and worthless at rest. The route hashes the incoming
-- path segment and looks up by hash. "Show me my URL again" therefore becomes
-- "re-issue", which is correct — it is an API key.

CREATE TABLE "public"."team_member_calendar_tokens" (
    "member_id"    "uuid" NOT NULL,
    "business_id"  "uuid" NOT NULL,
    -- SHA-256 hex of the raw token. The raw value is shown ONCE, at issue.
    "token_hash"   "text" NOT NULL,
    "issued_at"    timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone,
    "revoked_at"   timestamp with time zone,

    CONSTRAINT "team_member_calendar_tokens_pkey" PRIMARY KEY ("member_id"),
    CONSTRAINT "team_member_calendar_tokens_member_fkey"
      FOREIGN KEY ("member_id", "business_id")
      REFERENCES "public"."team_members"("id", "business_id") ON DELETE CASCADE,
    -- Global, not per-business: the token IS the identity, and the feed URL
    -- carries no business context to scope the lookup by.
    CONSTRAINT "team_member_calendar_tokens_token_hash_key" UNIQUE ("token_hash"),
    -- Makes storing a raw token a constraint violation, not a silent bug.
    CONSTRAINT "team_member_calendar_tokens_hash_shape"
      CHECK (("token_hash" ~ '^[0-9a-f]{64}$'::"text"))
);

-- ── leads.assigned_member_id ────────────────────────────────────────────────
--
-- SET NULL, never CASCADE: removing an agent must never delete their book of
-- clients. Those leads fall back to the business owner's roster number until
-- somebody reassigns them.
--
-- Composite, so a lead can only point at a member of its OWN business. PR #16
-- used a single-column FK here, which allowed a lead in business A to be
-- assigned to a member of business B — a cross-tenant delivery leak reachable
-- with entirely valid input.

ALTER TABLE "public"."leads"
  ADD COLUMN "assigned_member_id" "uuid";

ALTER TABLE "public"."leads"
  ADD CONSTRAINT "leads_assigned_member_fkey"
  FOREIGN KEY ("assigned_member_id", "business_id")
  REFERENCES "public"."team_members"("id", "business_id")
  ON DELETE SET NULL ("assigned_member_id");

CREATE INDEX "idx_leads_assigned_member"
  ON "public"."leads" ("assigned_member_id")
  WHERE ("assigned_member_id" IS NOT NULL);

-- ── contact_events ──────────────────────────────────────────────────────────
--
-- One date-bearing fact about a contact. `event_type` is text BY DESIGN — the
-- engine never learns what "insurance" is.
--
-- The composite lead FK is the cross-table tenant invariant. PR #16 enforced
-- it with a plpgsql BEFORE trigger; the FK is strictly stronger. It survives
-- session_replication_role = replica (which Supabase's own restore path sets,
-- and which silently disables user triggers), it cannot be quietly disabled
-- without a visible constraint drop, and it costs an index probe the FK was
-- going to do anyway. It also closes the direction the trigger missed: the
-- trigger fired on contact_events writes only, so nothing guarded the lead
-- side.

CREATE TABLE "public"."contact_events" (
    "id"          "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "lead_id"     "uuid" NOT NULL,
    "event_type"  "text" NOT NULL,
    "label"       "text",
    "event_date"  "date" NOT NULL,
    "recurrence"  "text" DEFAULT 'none'::"text" NOT NULL,
    "source"      "text" DEFAULT 'import'::"text" NOT NULL,
    -- Rendered into the suggestion prompt (policy no, insurer, premium, …).
    "payload"     "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at"  timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"  timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "contact_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contact_events_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "contact_events_lead_business_fkey"
      FOREIGN KEY ("lead_id", "business_id")
      REFERENCES "public"."leads"("id", "business_id") ON DELETE CASCADE,
    CONSTRAINT "contact_events_id_business_id_key" UNIQUE ("id", "business_id"),
    CONSTRAINT "contact_events_recurrence_check"
      CHECK (("recurrence" = ANY (ARRAY['none'::"text", 'yearly'::"text"]))),
    CONSTRAINT "contact_events_source_check"
      CHECK (("source" = ANY (ARRAY['import'::"text", 'api'::"text", 'manual'::"text"]))),
    CONSTRAINT "contact_events_type_not_blank"
      CHECK (("length"("btrim"("event_type")) > 0)),
    -- Re-import idempotency. NULLS NOT DISTINCT (PG15+) is REQUIRED: `label`
    -- is nullable, and under default NULL semantics every unlabelled re-import
    -- would insert a duplicate rather than conflicting.
    CONSTRAINT "contact_events_identity_key"
      UNIQUE NULLS NOT DISTINCT ("lead_id", "event_type", "event_date", "label")
);

CREATE INDEX "idx_contact_events_business" ON "public"."contact_events" ("business_id");
CREATE INDEX "idx_contact_events_lead" ON "public"."contact_events" ("lead_id");
-- The materialiser's scan: this tenant's events of this type.
CREATE INDEX "idx_contact_events_business_type"
  ON "public"."contact_events" ("business_id", "event_type");

CREATE TRIGGER "set_updated_at_contact_events" BEFORE UPDATE ON "public"."contact_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

-- ── reminder_rules ──────────────────────────────────────────────────────────
-- The operator's policy, as data.

CREATE TABLE "public"."reminder_rules" (
    "id"              "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id"     "uuid" NOT NULL,
    "event_type"      "text" NOT NULL,
    -- Fire this many days BEFORE the occurrence. 0 = on the day.
    "offset_days"     integer NOT NULL,
    "action"          "text" DEFAULT 'notify_agent'::"text" NOT NULL,
    -- 'assigned' → the lead's member (owner fallback); 'all_members' → fan out.
    "audience"        "text" DEFAULT 'assigned'::"text" NOT NULL,
    "suggest_message" boolean DEFAULT true NOT NULL,
    "send_window"     "public"."send_window" DEFAULT 'morning'::"public"."send_window" NOT NULL,
    "active"          boolean DEFAULT true NOT NULL,
    "created_at"      timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"      timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "reminder_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reminder_rules_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "reminder_rules_id_business_id_key" UNIQUE ("id", "business_id"),
    -- v1 only notifies a human. auto_send_template is deliberately absent:
    -- messaging the client with no human in the loop is a compliance decision,
    -- not a config flag. The single-valued CHECK makes adding one later a
    -- one-line change.
    CONSTRAINT "reminder_rules_action_check"
      CHECK (("action" = 'notify_agent'::"text")),
    CONSTRAINT "reminder_rules_audience_check"
      CHECK (("audience" = ANY (ARRAY['assigned'::"text", 'all_members'::"text"]))),
    -- Bounded, so a typo cannot schedule a reminder years out or in the past.
    CONSTRAINT "reminder_rules_offset_range"
      CHECK ((("offset_days" >= 0) AND ("offset_days" <= 365))),
    CONSTRAINT "reminder_rules_type_not_blank"
      CHECK (("length"("btrim"("event_type")) > 0)),
    -- `audience` is deliberately NOT in this key. Two rules with the same
    -- (type, offset) and different audiences would both target the assigned
    -- member and send that person the same WhatsApp twice — exactly the
    -- duplicate this design exists to prevent.
    CONSTRAINT "reminder_rules_identity_key"
      UNIQUE ("business_id", "event_type", "offset_days")
);

CREATE INDEX "idx_reminder_rules_business_active"
  ON "public"."reminder_rules" ("business_id") WHERE "active";

CREATE TRIGGER "set_updated_at_reminder_rules" BEFORE UPDATE ON "public"."reminder_rules"
  FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

-- ── reminders ───────────────────────────────────────────────────────────────
--
-- The materialised queue. THIS TABLE IS THE RELIABILITY MECHANISM:
-- reminders_identity_key below is the at-most-once guarantee, and it is
-- Postgres's, not the application's.
--
-- No updated_at trigger: rows are append-then-claim, and their lifecycle is
-- tracked by claimed_at / sent_at.

CREATE TABLE "public"."reminders" (
    "id"                  "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id"         "uuid" NOT NULL,
    "event_id"            "uuid" NOT NULL,
    "rule_id"             "uuid" NOT NULL,
    -- Which yearly occurrence this row is for: the anchor that makes a
    -- recurring event's reminders distinct year on year.
    "occurrence_date"     "date" NOT NULL,
    "due_at"              timestamp with time zone NOT NULL,
    -- Who this is FOR. NULL = unassigned, falls back to the owner's number.
    "member_id"           "uuid",
    "status"              "text" DEFAULT 'queued'::"text" NOT NULL,
    "claimed_at"          timestamp with time zone,
    "sent_at"             timestamp with time zone,
    "attempts"            integer DEFAULT 0 NOT NULL,
    "suggestion"          "text",
    "whatsapp_message_id" "text",
    "error"               "text",
    "created_at"          timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reminders_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "reminders_event_fkey" FOREIGN KEY ("event_id", "business_id")
      REFERENCES "public"."contact_events"("id", "business_id") ON DELETE CASCADE,
    CONSTRAINT "reminders_rule_fkey" FOREIGN KEY ("rule_id", "business_id")
      REFERENCES "public"."reminder_rules"("id", "business_id") ON DELETE CASCADE,
    -- NO ACTION, not RESTRICT. This is a fix to PR #16, not a style choice.
    -- RESTRICT is checked immediately, as a non-deferrable before-row action;
    -- NO ACTION is checked at end of statement. Deleting a business cascades
    -- to BOTH team_members and reminders in unspecified order, so under
    -- RESTRICT a tenant that had ever sent a reminder could never be deleted.
    -- Under NO ACTION the sibling cascade has already cleared the referencing
    -- rows by the time the check runs, while a DIRECT delete of a team member
    -- still fails loudly — which is the behaviour PR #16's comment wanted.
    -- The app soft-deletes via `active` regardless.
    -- MATCH SIMPLE, so the NULL owner-fallback row skips the check entirely.
    CONSTRAINT "reminders_member_fkey" FOREIGN KEY ("member_id", "business_id")
      REFERENCES "public"."team_members"("id", "business_id") ON DELETE NO ACTION,
    CONSTRAINT "reminders_status_check"
      CHECK (("status" = ANY (ARRAY['queued'::"text", 'claimed'::"text", 'sent'::"text",
                                    'failed'::"text", 'skipped'::"text"]))),
    CONSTRAINT "reminders_attempts_nonneg" CHECK (("attempts" >= 0)),
    -- At most once per (event, rule, occurrence) PER RECIPIENT. member_id is
    -- in the key so an 'all_members' rule fans out one row per agent without
    -- colliding; NULLS NOT DISTINCT so the unassigned/owner-fallback row is
    -- deduplicated too — under default semantics every run would insert
    -- another one.
    CONSTRAINT "reminders_identity_key"
      UNIQUE NULLS NOT DISTINCT ("event_id", "rule_id", "occurrence_date", "member_id")
);

-- The scheduler's hot path: due, not yet handled.
CREATE INDEX "idx_reminders_due"
  ON "public"."reminders" ("due_at") WHERE ("status" = 'queued'::"text");
-- The stuck-claim sweep. A worker that dies after claiming leaves the row in
-- 'claimed' forever, invisible to the delivery query. PR #16 shipped the sweep
-- but not this index, so finding those rows seq-scanned the whole queue.
CREATE INDEX "idx_reminders_stale_claims"
  ON "public"."reminders" ("claimed_at") WHERE ("status" = 'claimed'::"text");
-- The inbox tabs, index-ordered rather than sorted.
CREATE INDEX "idx_reminders_business_status"
  ON "public"."reminders" ("business_id", "status", "due_at" DESC);
-- Unindexed FKs make every parent delete seq-scan this table.
CREATE INDEX "idx_reminders_event"  ON "public"."reminders" ("event_id");
CREATE INDEX "idx_reminders_rule"   ON "public"."reminders" ("rule_id");
CREATE INDEX "idx_reminders_member" ON "public"."reminders" ("member_id");
-- Tripwire. One Meta message id against two reminders means we sent the same
-- thing twice and mis-booked one of them; this catches, from the other side,
-- exactly what the identity key exists to prevent.
CREATE UNIQUE INDEX "idx_reminders_whatsapp_message_id"
  ON "public"."reminders" ("whatsapp_message_id")
  WHERE ("whatsapp_message_id" IS NOT NULL);

-- ── contact_ingest_tokens ───────────────────────────────────────────────────
--
-- Bearer credentials for POST /api/v1/contacts. Declared before
-- contact_imports, which references it.
--
-- Named contact_ingest_tokens rather than ingest_tokens on purpose: the add-on
-- ships into a host that is actively growing tables, and a bare `ingest_tokens`
-- is a name that host will plausibly want for something else.

CREATE TABLE "public"."contact_ingest_tokens" (
    "id"           "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id"  "uuid" NOT NULL,
    "name"         "text" NOT NULL,
    -- SHA-256 hex of the raw token. Raw value shown ONCE, at creation.
    "token_hash"   "text" NOT NULL,
    -- First 8 chars of the raw token, so the UI can answer "which key is
    -- this?". Safe to display: 8 of 64 hex chars leaves 224 bits unguessed.
    "token_prefix" "text" NOT NULL,
    "created_by"   "uuid",
    "last_used_at" timestamp with time zone,
    "revoked_at"   timestamp with time zone,
    "created_at"   timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"   timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "contact_ingest_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contact_ingest_tokens_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "contact_ingest_tokens_id_business_id_key" UNIQUE ("id", "business_id"),
    CONSTRAINT "contact_ingest_tokens_created_by_fkey" FOREIGN KEY ("created_by")
      REFERENCES "auth"."users"("id") ON DELETE SET NULL,
    -- GLOBAL unique, not per-business. Load-bearing, not tidiness: the request
    -- carries no tenant identity, so the token IS the tenant resolution and
    -- the hash lookup must be unambiguous across the whole table.
    CONSTRAINT "contact_ingest_tokens_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "contact_ingest_tokens_hash_shape"
      CHECK (("token_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "contact_ingest_tokens_prefix_shape"
      CHECK (("length"("token_prefix") = 8)),
    CONSTRAINT "contact_ingest_tokens_name_not_blank"
      CHECK (("length"("btrim"("name")) > 0))
);

CREATE INDEX "idx_contact_ingest_tokens_business"
  ON "public"."contact_ingest_tokens" ("business_id")
  WHERE ("revoked_at" IS NULL);

CREATE TRIGGER "set_updated_at_contact_ingest_tokens"
  BEFORE UPDATE ON "public"."contact_ingest_tokens"
  FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

-- ── contact_imports ─────────────────────────────────────────────────────────
--
-- One upload or API batch. Distinct from the host's csv_imports, which is the
-- LEAD importer: this one carries date-bearing events and an attribution
-- column, and its failures go to a review queue rather than a counter.
--
-- There is no file_path. The spreadsheet is parsed synchronously in the server
-- action and never stored, so there is no bucket to provision — which is also
-- how the standalone avoids the host's "storage buckets are not in source
-- control" failure mode.

CREATE TABLE "public"."contact_imports" (
    "id"              "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id"     "uuid" NOT NULL,
    "source"          "text" NOT NULL,
    -- Display only. NULL for source='api'.
    "file_name"       "text",
    "status"          "text" DEFAULT 'pending'::"text" NOT NULL,
    "total_rows"      integer DEFAULT 0 NOT NULL,
    "created_rows"    integer DEFAULT 0 NOT NULL,
    "updated_rows"    integer DEFAULT 0 NOT NULL,
    "events_created"  integer DEFAULT 0 NOT NULL,
    "review_rows"     integer DEFAULT 0 NOT NULL,
    "errors"          "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    -- Provenance for source='api'.
    "ingest_token_id" "uuid",
    "created_by"      "uuid",
    "created_at"      timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"      timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "contact_imports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contact_imports_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "contact_imports_id_business_id_key" UNIQUE ("id", "business_id"),
    CONSTRAINT "contact_imports_token_fkey"
      FOREIGN KEY ("ingest_token_id", "business_id")
      REFERENCES "public"."contact_ingest_tokens"("id", "business_id")
      ON DELETE SET NULL ("ingest_token_id"),
    CONSTRAINT "contact_imports_created_by_fkey" FOREIGN KEY ("created_by")
      REFERENCES "auth"."users"("id") ON DELETE SET NULL,
    CONSTRAINT "contact_imports_source_check"
      CHECK (("source" = ANY (ARRAY['upload'::"text", 'api'::"text"]))),
    CONSTRAINT "contact_imports_status_check"
      CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text",
                                    'completed'::"text", 'failed'::"text"]))),
    CONSTRAINT "contact_imports_counts_nonneg"
      CHECK ((("total_rows" >= 0) AND ("created_rows" >= 0) AND ("updated_rows" >= 0)
          AND ("events_created" >= 0) AND ("review_rows" >= 0)))
);

CREATE INDEX "idx_contact_imports_business"
  ON "public"."contact_imports" ("business_id", "created_at" DESC);

CREATE TRIGGER "set_updated_at_contact_imports" BEFORE UPDATE ON "public"."contact_imports"
  FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

-- ── contact_import_reviews ──────────────────────────────────────────────────
--
-- The rows an import could not attribute or parse.
--
-- PR #16 only COUNTED these, which meant the operator's answer to "17 rows
-- skipped" was "re-upload and hope". Persisting the raw row makes the failure
-- resolvable in the UI without the source file, and (import_id, row_number)
-- makes re-processing an import update the queue rather than duplicate it.

CREATE TABLE "public"."contact_import_reviews" (
    "id"               "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id"      "uuid" NOT NULL,
    "import_id"        "uuid" NOT NULL,
    -- 1-based line in the file, or index in the API payload array.
    "row_number"       integer NOT NULL,
    -- The row exactly as received, so it can be re-parsed after a mapping fix.
    "raw"              "jsonb" NOT NULL,
    -- Best-effort normalisation, prefilled into the resolve form.
    "parsed"           "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "reason"           "text" NOT NULL,
    "detail"           "text",
    "status"           "text" DEFAULT 'pending'::"text" NOT NULL,
    "resolved_lead_id" "uuid",
    "resolved_by"      "uuid",
    "resolved_at"      timestamp with time zone,
    "created_at"       timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"       timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "contact_import_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contact_import_reviews_business_id_fkey" FOREIGN KEY ("business_id")
      REFERENCES "public"."businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "contact_import_reviews_import_fkey"
      FOREIGN KEY ("import_id", "business_id")
      REFERENCES "public"."contact_imports"("id", "business_id") ON DELETE CASCADE,
    CONSTRAINT "contact_import_reviews_lead_fkey"
      FOREIGN KEY ("resolved_lead_id", "business_id")
      REFERENCES "public"."leads"("id", "business_id")
      ON DELETE SET NULL ("resolved_lead_id"),
    CONSTRAINT "contact_import_reviews_resolved_by_fkey" FOREIGN KEY ("resolved_by")
      REFERENCES "auth"."users"("id") ON DELETE SET NULL,
    -- A CLOSED set, unlike contact_events.event_type: these are emitted by our
    -- own parser, so a typo must fail at write time rather than quietly become
    -- a filter value that nothing matches.
    CONSTRAINT "contact_import_reviews_reason_check"
      CHECK (("reason" = ANY (ARRAY['missing_name'::"text",
                                    'missing_phone'::"text",
                                    'invalid_phone'::"text",
                                    'unknown_member'::"text",
                                    'ambiguous_member'::"text",
                                    'unparseable_date'::"text",
                                    'duplicate_in_batch'::"text"]))),
    CONSTRAINT "contact_import_reviews_status_check"
      CHECK (("status" = ANY (ARRAY['pending'::"text", 'resolved'::"text",
                                    'dismissed'::"text"]))),
    -- Resolved means a lead exists; pending and dismissed mean none does.
    CONSTRAINT "contact_import_reviews_resolution_coherent"
      CHECK (((("status" = 'resolved'::"text") AND ("resolved_lead_id" IS NOT NULL)
                                               AND ("resolved_at" IS NOT NULL))
           OR (("status" <> 'resolved'::"text") AND ("resolved_lead_id" IS NULL)))),
    CONSTRAINT "contact_import_reviews_row_key" UNIQUE ("import_id", "row_number"),
    CONSTRAINT "contact_import_reviews_row_number_positive"
      CHECK (("row_number" >= 1))
);

-- The queue itself, and the "N need attention" badge.
CREATE INDEX "idx_contact_import_reviews_pending"
  ON "public"."contact_import_reviews" ("business_id", "created_at" DESC)
  WHERE ("status" = 'pending'::"text");
CREATE INDEX "idx_contact_import_reviews_import"
  ON "public"."contact_import_reviews" ("import_id");

CREATE TRIGGER "set_updated_at_contact_import_reviews"
  BEFORE UPDATE ON "public"."contact_import_reviews"
  FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- Member SELECT only, on everything the UI renders. Every write is a server
-- action or the scheduled tick on the service-role client, which bypasses RLS
-- — so a write policy would be surface with no purpose. This is also the
-- lesson of the host's 20260729160000_csv_imports_no_member_insert: RLS can
-- check the business_id claim but never the CONTENTS of a row.
--
-- auth.uid() is reached through member_business_ids(), which is STABLE, so the
-- planner evaluates it once per statement rather than once per row.

ALTER TABLE "public"."team_members"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."contact_events"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."reminder_rules"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."reminders"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."contact_imports"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."contact_import_reviews" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_members_member_select" ON "public"."team_members"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));
CREATE POLICY "contact_events_member_select" ON "public"."contact_events"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));
CREATE POLICY "reminder_rules_member_select" ON "public"."reminder_rules"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));
CREATE POLICY "reminders_member_select" ON "public"."reminders"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));
CREATE POLICY "contact_imports_member_select" ON "public"."contact_imports"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));
CREATE POLICY "contact_import_reviews_member_select" ON "public"."contact_import_reviews"
  FOR SELECT TO "authenticated"
  USING ("business_id" IN (SELECT "public"."member_business_ids"()));

-- Secret tables: RLS on, ZERO policies. Both hold credential digests, and RLS
-- is row-level — any SELECT policy ships token_hash to the browser alongside
-- whatever the UI actually wanted. The settings pages read the display columns
-- through service-role server actions instead.
ALTER TABLE "public"."contact_ingest_tokens"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."team_member_calendar_tokens" ENABLE ROW LEVEL SECURITY;

-- ── GRANTs ──────────────────────────────────────────────────────────────────
--
-- REQUIRED, not belt-and-braces. Supabase's "auto-expose new public tables to
-- the Data API roles" default flipped to false on 2026-05-30, and these tables
-- are created after that date — so without explicit grants EVERY query 42501s,
-- including service_role, which bypasses RLS but still goes through PostgREST
-- and still needs table privileges.
--
-- `anon` is granted nothing, anywhere. No browser code reads any of these
-- tables unauthenticated, so a grant would buy nothing and leave the secret
-- tables one dropped policy away from exposure.

GRANT SELECT ON TABLE
  "public"."team_members",
  "public"."contact_events",
  "public"."reminder_rules",
  "public"."reminders",
  "public"."contact_imports",
  "public"."contact_import_reviews"
  TO "authenticated";

GRANT ALL ON TABLE
  "public"."team_members",
  "public"."contact_events",
  "public"."reminder_rules",
  "public"."reminders",
  "public"."contact_imports",
  "public"."contact_import_reviews"
  TO "service_role";

REVOKE ALL ON TABLE "public"."contact_ingest_tokens"       FROM "anon", "authenticated";
REVOKE ALL ON TABLE "public"."team_member_calendar_tokens" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."contact_ingest_tokens"        TO "service_role";
GRANT ALL ON TABLE "public"."team_member_calendar_tokens"  TO "service_role";

-- ── Documentation ───────────────────────────────────────────────────────────

COMMENT ON TABLE "public"."team_members" IS
  'Attribution roster and reminder DESTINATIONS. Not login seats — auth_user_id optionally links a member to a business_members seat.';
COMMENT ON TABLE "public"."contact_events" IS
  'A date-bearing fact about a lead (birthday, policy expiry, review date). event_type is free text by design — the engine is vertical-agnostic.';
COMMENT ON TABLE "public"."reminder_rules" IS
  'Per-tenant config mapping an event_type + lead time to a notification.';
COMMENT ON TABLE "public"."reminders" IS
  'Materialised reminder queue. The unique key (event, rule, occurrence, member) is the at-most-once guarantee.';
COMMENT ON TABLE "public"."contact_import_reviews" IS
  'Rows an import could not attribute or parse, persisted so the operator can resolve them without the source file.';
COMMENT ON COLUMN "public"."team_member_calendar_tokens"."token_hash" IS
  'SHA-256 hex of the ICS feed token. Rotate to revoke. The raw value is shown once, at issue, and never stored.';


-- ══════════════════════════════════════════════════════════════════════════
-- 20260820090000_whatsapp_inbound.sql
-- ══════════════════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════════════════
-- 20260828100000_status_events.sql
-- ══════════════════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════════════════
-- 20260830100000_scheduler_runs.sql
-- ══════════════════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════════════════
-- 20260830140000_event_type_counts.sql
-- ══════════════════════════════════════════════════════════════════════════

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


-- ══════════════════════════════════════════════════════════════════════════
-- 20260830180000_auto_send_flag.sql
-- ══════════════════════════════════════════════════════════════════════════

-- Whether the scheduler is allowed to send for this business.
--
-- WHY A COLUMN AND NOT A DEPLOYMENT SETTING. Sending used to be switched off by
-- deleting the schedulers themselves — the `crons` block in vercel.json and the
-- GitHub Actions workflow. That works, but only somebody with repository access
-- can do it, the app cannot report the true state, and it took days to notice
-- that disabling ONE of the two left the other still firing. The operator needs
-- a switch they can see and reach, and the app needs to be able to answer "will
-- anything be sent?" honestly.
--
-- DEFAULT FALSE, and that is the whole safety property. The scheduler runs on a
-- timer again, so the flag is the only thing standing between a tick and a bill.
-- A new business — and this one, on migration — starts silent, and stays silent
-- until somebody deliberately turns it on. An off tick costs one SELECT: the
-- cycle checks this before it materialises, drafts, or claims anything.
--
-- Manual sends from the Reminders page deliberately IGNORE this flag. It gates
-- the machine, not the operator: "automatic sending is off" must not also mean
-- "I cannot send this one thing myself".

ALTER TABLE "public"."businesses"
  ADD COLUMN IF NOT EXISTS "auto_send_enabled" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "public"."businesses"."auto_send_enabled" IS
  'Scheduler may deliver for this business. Default false; manual sends ignore it.';


-- ══════════════════════════════════════════════════════════════════════════
-- 20260901000000_reminder_error_code.sql
-- ══════════════════════════════════════════════════════════════════════════

-- Meta's failure code, kept as a column instead of only inside a sentence.
--
-- `reminders.error` already carries the reason, flattened by describeErrors to
-- a line like "[131047] Re-engagement message". That reads well and is useless
-- to query: "how many 131047s this week", "is this number permanently bad or
-- was it a rate limit" and "may this be retried" are all questions about the
-- CODE, and the code was only ever a prefix inside prose.
--
-- It matters most for the retry decision. Retrying 131026 — the handset is not
-- on WhatsApp — burns three billed sends against a number that will never
-- receive one, while 130429 is a rate limit that wants exactly the opposite
-- treatment. Deciding that by pattern-matching an error string is how you ship
-- a retry policy that quietly does the wrong thing on the day the wording
-- changes.
--
-- Nullable throughout: Meta does not always send a code, older rows have none,
-- and a failure with no code is still a failure. No CHECK — the code space is
-- Meta's, it grows without telling us, and a constraint here would turn "Meta
-- shipped a new code" into a failed webhook write.
--
-- THIS MIGRATION IS MEANT FOR THE HOST. Like 20260828100000_status_events.sql,
-- it applies as-is when integrating into GomaAI.

ALTER TABLE "public"."reminders"
  ADD COLUMN IF NOT EXISTS "error_code" "text";

ALTER TABLE "public"."whatsapp_status_events"
  ADD COLUMN IF NOT EXISTS "error_code" "text";

COMMENT ON COLUMN "public"."reminders"."error_code" IS
  'Meta error code for the failure in `error`, when Meta gave one. Drives the retry decision; see src/lib/whatsapp-errors.ts.';

COMMENT ON COLUMN "public"."whatsapp_status_events"."error_code" IS
  'Meta error code as delivered on the receipt. Kept alongside the flattened `error` so failures can be counted by cause.';

-- Answers "what has been failing, and why" without a scan. Partial, because
-- the happy receipts vastly outnumber the failures and none of them have a
-- code to group by.
CREATE INDEX IF NOT EXISTS "whatsapp_status_events_error_code_idx"
  ON "public"."whatsapp_status_events" ("error_code", "received_at" DESC)
  WHERE ("error_code" IS NOT NULL);


-- ══════════════════════════════════════════════════════════════════════════
-- 20260901020000_reminder_retry_schedule.sql
-- ══════════════════════════════════════════════════════════════════════════

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
-- RENAMED from 20260828000000, which is where this file lives on
-- claude/whatsapp-webhook-validation-tswrys. That timestamp sorts BEFORE four
-- migrations already applied to the live database, so `supabase db push`
-- refuses it without --include-all and scripts/sql-bundle.ts, which sorts by
-- filename, replays it in the wrong position.
--
-- IF NOT EXISTS so that merging that branch later — which brings the original
-- filename back — is a no-op rather than an error.
ALTER TABLE "public"."reminders"
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;

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


-- ══════════════════════════════════════════════════════════════════════════
-- 20260901030000_reassign_contact_reminders.sql
-- ══════════════════════════════════════════════════════════════════════════

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

