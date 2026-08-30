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
