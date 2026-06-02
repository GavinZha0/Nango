-- Drop the old `is_supervisor`-based partial index — the new
-- supervisor index reuses the same name.
DROP INDEX "builtin_agent_one_supervisor_per_user_idx";--> statement-breakpoint

-- Scrub legacy free-text `role` values BEFORE the CHECK constraint;
-- old text would block the ALTER TABLE otherwise.
UPDATE "builtin_agent" SET "role" = NULL;--> statement-breakpoint

ALTER TABLE "builtin_agent"
  ADD CONSTRAINT "builtin_agent_role_check"
  CHECK ("role" IS NULL OR "role" IN ('supervisor', 'secretary', 'evaluator'));--> statement-breakpoint

-- Per-role partial unique indexes (evaluator intentionally
-- unconstrained). NULL created_by treated as distinct so orphan rows
-- post owner hard-purge are tolerated.
CREATE UNIQUE INDEX "builtin_agent_one_secretary_per_user_idx" ON "builtin_agent" USING btree ("created_by") WHERE "builtin_agent"."role" = 'secretary';--> statement-breakpoint
CREATE UNIQUE INDEX "builtin_agent_one_supervisor_per_user_idx" ON "builtin_agent" USING btree ("created_by") WHERE "builtin_agent"."role" = 'supervisor';--> statement-breakpoint

-- Pre-existing `is_supervisor = true` rows are NOT migrated to
-- `role = 'supervisor'` — owners re-create / re-promote through the UI.
ALTER TABLE "builtin_agent" DROP COLUMN "is_supervisor";
