ALTER TABLE "eval_suite" ADD COLUMN "variables" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD COLUMN "variables" jsonb DEFAULT '{}'::jsonb NOT NULL;