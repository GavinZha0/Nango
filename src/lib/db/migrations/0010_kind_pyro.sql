DROP INDEX "verification_suite_mcp_tool_unique_idx";--> statement-breakpoint
DROP INDEX "verification_suite_workflow_unique_idx";--> statement-breakpoint
ALTER TABLE "eval_suite" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_suite_mcp_tool_user_idx" ON "verification_suite" USING btree ("mcp_server_id","tool_name","created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_suite_workflow_user_idx" ON "verification_suite" USING btree ("workflow_id","created_by");