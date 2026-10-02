ALTER TABLE "eval_agent_run" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "eval_agent_run" CASCADE;--> statement-breakpoint
ALTER TABLE "eval_run" DROP CONSTRAINT IF EXISTS "eval_run_agent_run_id_eval_agent_run_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "eval_run_agent_run_idx";--> statement-breakpoint
ALTER TABLE "eval_run" ADD COLUMN "threshold" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_suite" ADD COLUMN "threshold" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_case_result" DROP COLUMN "score";--> statement-breakpoint
ALTER TABLE "eval_case_result" DROP COLUMN "dimension_scores";--> statement-breakpoint
ALTER TABLE "eval_case_result" DROP COLUMN "criteria_score";--> statement-breakpoint
ALTER TABLE "eval_run" DROP COLUMN "agent_run_id";--> statement-breakpoint
ALTER TABLE "eval_run" DROP COLUMN "score";--> statement-breakpoint
ALTER TABLE "eval_suite" DROP COLUMN "dimension_ids";