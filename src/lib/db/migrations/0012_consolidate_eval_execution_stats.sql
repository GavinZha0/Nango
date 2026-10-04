ALTER TABLE "eval_case_result" ADD COLUMN "execution_stats" jsonb;--> statement-breakpoint
ALTER TABLE "eval_case_result" DROP COLUMN "ttft_ms";--> statement-breakpoint
ALTER TABLE "eval_case_result" DROP COLUMN "duration_ms";--> statement-breakpoint
ALTER TABLE "eval_case_result" DROP COLUMN "output_tokens";
