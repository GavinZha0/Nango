ALTER TABLE "eval_suite" RENAME COLUMN "target_timeout_sec" TO "case_timeout_sec";--> statement-breakpoint
ALTER TABLE "verification_suite" RENAME COLUMN "tool_timeout_sec" TO "case_timeout_sec";--> statement-breakpoint
ALTER TABLE "web_auto_suite" RENAME COLUMN "timeout_sec" TO "case_timeout_sec";