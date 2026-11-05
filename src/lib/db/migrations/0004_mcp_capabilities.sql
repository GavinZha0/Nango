ALTER TABLE "mcp_server" ADD COLUMN "protocol_era" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "protocol_version" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "server_capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "prompts" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "resources" jsonb;