-- SECURITY: deleting an MCP server must never cascade-delete verification
-- suites / runs / results. Switch the mcp_server FKs to ON DELETE SET NULL
-- so suites become "detached" (kept for manual editing, history browsing
-- and deletion; running is refused at the API/tool layer), and widen
-- verification_suite_target_xor to make the both-NULL detached shape legal
-- (only both-NON-NULL stays forbidden).

ALTER TABLE "verification_suite" DROP CONSTRAINT "verification_suite_mcp_server_id_mcp_server_id_fk";--> statement-breakpoint
ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_run" DROP CONSTRAINT "verification_run_mcp_server_id_mcp_server_id_fk";--> statement-breakpoint
ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_suite" DROP CONSTRAINT "verification_suite_target_xor";--> statement-breakpoint
ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_target_xor" CHECK (
  NOT (
    "mcp_server_id" IS NOT NULL AND "workflow_id" IS NOT NULL
  )
);
