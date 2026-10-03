ALTER TABLE "builtin_agent" ALTER COLUMN "max_steps" SET DEFAULT 20;--> statement-breakpoint
ALTER TABLE "builtin_agent" ALTER COLUMN "tool_approval_mode" SET DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "web_auto_suite" ALTER COLUMN "timeout_sec" SET DEFAULT 60;