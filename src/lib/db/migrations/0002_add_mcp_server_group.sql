ALTER TABLE "builtin_agent" ALTER COLUMN "max_steps" SET DEFAULT 10;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "group" text;--> statement-breakpoint
CREATE INDEX "mcp_server_group_idx" ON "mcp_server" USING btree ("group");