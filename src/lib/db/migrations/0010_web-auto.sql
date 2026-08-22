CREATE TABLE "web_auto_case_result" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_auto_case_result_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text NOT NULL,
	"execution_output" jsonb,
	"verdict" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_auto_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"script_content" text,
	"assertions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "web_auto_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"errored" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "web_auto_suite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"timeout_sec" integer DEFAULT 300 NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "web_auto_case_result" ADD CONSTRAINT "web_auto_case_result_run_id_web_auto_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."web_auto_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_case_result" ADD CONSTRAINT "web_auto_case_result_case_id_web_auto_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."web_auto_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_case" ADD CONSTRAINT "web_auto_case_suite_id_web_auto_suite_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."web_auto_suite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_case" ADD CONSTRAINT "web_auto_case_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_case" ADD CONSTRAINT "web_auto_case_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_run" ADD CONSTRAINT "web_auto_run_suite_id_web_auto_suite_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."web_auto_suite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_run" ADD CONSTRAINT "web_auto_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_suite" ADD CONSTRAINT "web_auto_suite_parent_id_web_auto_suite_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."web_auto_suite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_suite" ADD CONSTRAINT "web_auto_suite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auto_suite" ADD CONSTRAINT "web_auto_suite_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;