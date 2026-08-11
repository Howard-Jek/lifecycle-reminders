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
