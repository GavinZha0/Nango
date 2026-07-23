CREATE TABLE "safety_interception_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "safety_interception_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid,
	"user_id" text,
	"stage" text NOT NULL,
	"category" text NOT NULL,
	"policy_id" bigint,
	"policy_name" text,
	"policy_type" text,
	"tool_name" text,
	"action" text NOT NULL,
	"severity" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "safety_log_created_at_idx" ON "safety_interception_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "safety_log_stage_cat_idx" ON "safety_interception_log" USING btree ("stage","category");