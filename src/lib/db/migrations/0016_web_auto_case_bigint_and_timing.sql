ALTER TABLE "web_auto_case" ADD COLUMN IF NOT EXISTS "new_id" bigint GENERATED ALWAYS AS IDENTITY;--> statement-breakpoint
ALTER TABLE "web_auto_case_result" DROP CONSTRAINT IF EXISTS "web_auto_case_result_case_id_web_auto_case_id_fk";--> statement-breakpoint
ALTER TABLE "web_auto_case" DROP CONSTRAINT IF EXISTS "web_auto_case_pkey" CASCADE;--> statement-breakpoint
ALTER TABLE "web_auto_case" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "web_auto_case" RENAME COLUMN "new_id" TO "id";--> statement-breakpoint
ALTER TABLE "web_auto_case" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "web_auto_case_result" DROP COLUMN IF EXISTS "case_id";--> statement-breakpoint
ALTER TABLE "web_auto_case_result" ADD COLUMN "case_id" bigint NOT NULL REFERENCES "web_auto_case"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "web_auto_case_result" ADD COLUMN IF NOT EXISTS "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "web_auto_case_result" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_auto_case_result" ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;