CREATE TABLE IF NOT EXISTS "verification_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
TRUNCATE TABLE 
  verification_case_result, 
  verification_run, 
  verification_case, 
  verification_suite,
  verification_group
CASCADE;
--> statement-breakpoint
ALTER TABLE "verification_run" DROP CONSTRAINT IF EXISTS "verification_run_target_xor";--> statement-breakpoint
ALTER TABLE "verification_suite" DROP CONSTRAINT IF EXISTS "verification_suite_target_xor";--> statement-breakpoint
ALTER TABLE "verification_case_result" DROP CONSTRAINT IF EXISTS "verification_case_result_entity_run_id_entity_run_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_run" DROP CONSTRAINT IF EXISTS "verification_run_mcp_server_id_mcp_server_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "verification_run_server_started_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "verification_suite_mcp_user_name_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "verification_suite_workflow_user_idx";--> statement-breakpoint
ALTER TABLE "verification_case" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_run" ALTER COLUMN "suite_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_suite" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_suite" ALTER COLUMN "updated_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_case_result" ADD COLUMN IF NOT EXISTS "original_tool_name" text;--> statement-breakpoint
ALTER TABLE "verification_case_result" ADD COLUMN IF NOT EXISTS "effective_tool_name" text;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD COLUMN IF NOT EXISTS "group_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD COLUMN IF NOT EXISTS "tool_prefix_rule" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_group_lower_name_idx" ON "verification_group" USING btree (lower("name"));--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'verification_suite_group_id_verification_group_id_fk'
  ) THEN
    ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_group_id_verification_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."verification_group"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_suite_user_name_idx" ON "verification_suite" USING btree ("name","created_by");--> statement-breakpoint
ALTER TABLE "verification_case_result" DROP COLUMN IF EXISTS "entity_run_id";--> statement-breakpoint
ALTER TABLE "verification_run" DROP COLUMN IF EXISTS "mcp_server_id";--> statement-breakpoint
ALTER TABLE "verification_suite" DROP COLUMN IF EXISTS "category";--> statement-breakpoint
ALTER TABLE "verification_suite" DROP COLUMN IF EXISTS "workflow_id";