-- Remove built-in skill rows (product never shipped; the builtin pipeline
-- is gone). skill_file and builtin_agent_tool rows cascade via FK.
DELETE FROM "skill" WHERE "source" = 'builtin';--> statement-breakpoint
-- `source` becomes a free-form user label: clear the meaningless legacy
-- values ("local") before the default flips.
UPDATE "skill" SET "source" = '';--> statement-breakpoint
ALTER TABLE "skill" ALTER COLUMN "source" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "skill" DROP COLUMN "checksum";