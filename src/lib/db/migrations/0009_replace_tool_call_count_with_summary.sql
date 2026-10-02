ALTER TABLE "eval_case_result" ADD COLUMN "tool_call_summary" jsonb;--> statement-breakpoint
ALTER TABLE "eval_case_result" DROP COLUMN "tool_call_count";