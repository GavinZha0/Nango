CREATE TABLE "eval_agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"score" integer,
	"total_count" integer NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"errored_count" integer DEFAULT 0 NOT NULL,
	"triggered_by" text NOT NULL,
	"created_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_case_result" (
	"run_id" uuid NOT NULL,
	"case_id" bigint NOT NULL,
	"status" text NOT NULL,
	"score" integer,
	"dimension_scores" jsonb,
	"feedback" text,
	"thread_id" uuid,
	"evaluator_thread_id" uuid,
	"error" jsonb,
	"ttft_ms" integer,
	"duration_ms" integer,
	"tokens" integer,
	"started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "eval_case_result_run_id_case_id_pk" PRIMARY KEY("run_id","case_id")
);
--> statement-breakpoint
CREATE TABLE "eval_case" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "eval_case_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"suite_id" uuid NOT NULL,
	"name" text NOT NULL,
	"turns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dimension_override" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"status" text NOT NULL,
	"score" integer,
	"total_count" integer NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"errored_count" integer DEFAULT 0 NOT NULL,
	"triggered_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_suite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"agent_source" text DEFAULT 'builtin' NOT NULL,
	"credential_id" uuid,
	"evaluator_agent_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"dimension_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_agent_run" ADD CONSTRAINT "eval_agent_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case_result" ADD CONSTRAINT "eval_case_result_run_id_eval_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case_result" ADD CONSTRAINT "eval_case_result_case_id_eval_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case" ADD CONSTRAINT "eval_case_suite_id_eval_suite_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_suite_id_eval_suite_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_agent_run_id_eval_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."eval_agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_suite" ADD CONSTRAINT "eval_suite_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_suite" ADD CONSTRAINT "eval_suite_evaluator_agent_id_builtin_agent_id_fk" FOREIGN KEY ("evaluator_agent_id") REFERENCES "public"."builtin_agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_suite" ADD CONSTRAINT "eval_suite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_suite" ADD CONSTRAINT "eval_suite_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_agent_run_agent_idx" ON "eval_agent_run" USING btree ("agent_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "eval_case_result_case_started_idx" ON "eval_case_result" USING btree ("case_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "eval_case_suite_idx" ON "eval_case" USING btree ("suite_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_case_suite_name_unique_idx" ON "eval_case" USING btree ("suite_id","name");--> statement-breakpoint
CREATE INDEX "eval_run_suite_started_idx" ON "eval_run" USING btree ("suite_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "eval_run_agent_run_idx" ON "eval_run" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "eval_run_recovery_idx" ON "eval_run" USING btree ("started_at") WHERE "eval_run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "eval_suite_agent_idx" ON "eval_suite" USING btree ("agent_id","agent_source");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_suite_name_unique_idx" ON "eval_suite" USING btree ("agent_id","agent_source","name");