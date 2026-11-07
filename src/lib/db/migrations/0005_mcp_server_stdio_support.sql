ALTER TABLE "mcp_server" ALTER COLUMN "url" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "command" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "args" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "env" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "cwd" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "credential_env_name" text;