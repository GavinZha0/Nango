-- ONE-TIME DESTRUCTIVE RESET FOR VERIFICATION SUBSYSTEM REFACTORING
-- NOTE: Explicitly excludes better-auth's "auth_token" table!
TRUNCATE TABLE 
  verification_case_result, 
  verification_run, 
  verification_case, 
  verification_suite 
CASCADE;
--> statement-breakpoint
CREATE TABLE "verification_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification_run" DROP CONSTRAINT "verification_run_target_xor";--> statement-breakpoint
ALTER TABLE "verification_suite" DROP CONSTRAINT "verification_suite_target_xor";--> statement-breakpoint
ALTER TABLE "verification_case_result" DROP CONSTRAINT "verification_case_result_entity_run_id_entity_run_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_run" DROP CONSTRAINT "verification_run_mcp_server_id_mcp_server_id_fk";
--> statement-breakpoint
DROP INDEX "verification_run_server_started_idx";--> statement-breakpoint
DROP INDEX "verification_suite_mcp_user_name_idx";--> statement-breakpoint
DROP INDEX "verification_suite_workflow_user_idx";--> statement-breakpoint
ALTER TABLE "verification_case" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_run" ALTER COLUMN "suite_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_suite" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_suite" ALTER COLUMN "updated_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_case_result" ADD COLUMN "original_tool_name" text;--> statement-breakpoint
ALTER TABLE "verification_case_result" ADD COLUMN "effective_tool_name" text;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD COLUMN "tool_prefix_rule" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_group_lower_name_idx" ON "verification_group" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_group_id_verification_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."verification_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_suite_user_name_idx" ON "verification_suite" USING btree ("name","created_by");--> statement-breakpoint
ALTER TABLE "verification_case_result" DROP COLUMN "entity_run_id";--> statement-breakpoint
ALTER TABLE "verification_run" DROP COLUMN "mcp_server_id";--> statement-breakpoint
ALTER TABLE "verification_suite" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "verification_suite" DROP COLUMN "workflow_id";