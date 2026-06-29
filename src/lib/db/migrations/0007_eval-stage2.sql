ALTER TABLE "eval_case_result" RENAME COLUMN "tokens" TO "output_tokens";--> statement-breakpoint
ALTER TABLE "eval_case_result" ADD COLUMN "criteria_score" integer;--> statement-breakpoint
ALTER TABLE "eval_case_result" ADD COLUMN "criteria_results" jsonb;--> statement-breakpoint
ALTER TABLE "eval_case_result" ADD COLUMN "tool_call_count" integer;--> statement-breakpoint
ALTER TABLE "eval_case" DROP COLUMN "dimension_override";