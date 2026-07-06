DELETE FROM "verification_case_result";--> statement-breakpoint
DELETE FROM "verification_run";--> statement-breakpoint
DELETE FROM "verification_case";--> statement-breakpoint
DELETE FROM "verification_suite";--> statement-breakpoint
ALTER TABLE "verification_suite" DROP CONSTRAINT "verification_suite_name_unique";--> statement-breakpoint
ALTER TABLE "verification_case" DROP CONSTRAINT "verification_case_target_xor";--> statement-breakpoint
ALTER TABLE "verification_case" DROP CONSTRAINT "verification_case_mcp_server_id_mcp_server_id_fk";
--> statement-breakpoint
DROP INDEX "verification_case_mcp_tool_idx";--> statement-breakpoint
ALTER TABLE "verification_run" ALTER COLUMN "suite_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_run" ADD COLUMN "mcp_server_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD COLUMN "mcp_server_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD COLUMN "tool_name" text;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_run_server_started_idx" ON "verification_run" USING btree ("mcp_server_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "verification_suite_mcp_tool_unique_idx" ON "verification_suite" USING btree ("mcp_server_id","tool_name");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_suite_workflow_unique_idx" ON "verification_suite" USING btree ("workflow_id");--> statement-breakpoint
ALTER TABLE "verification_case" DROP COLUMN "mcp_server_id";--> statement-breakpoint
ALTER TABLE "verification_case" DROP COLUMN "tool_name";--> statement-breakpoint
ALTER TABLE "verification_case" DROP COLUMN "workflow_id";--> statement-breakpoint
ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_target_xor" CHECK ((
        ("verification_run"."suite_id" IS NOT NULL AND "verification_run"."mcp_server_id" IS NULL)
        OR
        ("verification_run"."suite_id" IS NULL AND "verification_run"."mcp_server_id" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_target_xor" CHECK ((
        ("verification_suite"."mcp_server_id" IS NOT NULL AND "verification_suite"."tool_name" IS NOT NULL AND "verification_suite"."workflow_id" IS NULL)
        OR
        ("verification_suite"."mcp_server_id" IS NULL AND "verification_suite"."tool_name" IS NULL AND "verification_suite"."workflow_id" IS NOT NULL)
      ));