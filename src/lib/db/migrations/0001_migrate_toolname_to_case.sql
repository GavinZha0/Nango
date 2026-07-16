ALTER TABLE "verification_suite" DROP CONSTRAINT "verification_suite_target_xor";--> statement-breakpoint
DROP INDEX "verification_suite_mcp_tool_user_idx";--> statement-breakpoint
ALTER TABLE "verification_case" ADD COLUMN "tool_name" text;--> statement-breakpoint
UPDATE "verification_case" c SET "tool_name" = s."tool_name" FROM "verification_suite" s WHERE c."suite_id" = s."id";--> statement-breakpoint
CREATE UNIQUE INDEX "verification_suite_mcp_user_name_idx" ON "verification_suite" USING btree ("mcp_server_id","name","created_by");--> statement-breakpoint
ALTER TABLE "verification_suite" DROP COLUMN "tool_name";--> statement-breakpoint
ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_target_xor" CHECK ((
        ("verification_suite"."mcp_server_id" IS NOT NULL AND "verification_suite"."workflow_id" IS NULL)
        OR
        ("verification_suite"."mcp_server_id" IS NULL AND "verification_suite"."workflow_id" IS NOT NULL)
      ));