CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"type" text,
	"name" text NOT NULL,
	"description" text,
	"content" jsonb,
	"config" jsonb,
	"source_thread_id" text,
	"source_outcome_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"workflow_id" uuid,
	"workflow_output_field" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backend_thread_state" (
	"credential_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "backend_thread_state_credential_id_thread_id_pk" PRIMARY KEY("credential_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "builtin_agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_supervisor" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"role" text,
	"model" text NOT NULL,
	"model_provider" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"prompt" text,
	"temperature" text,
	"max_tokens" integer,
	"max_steps" integer DEFAULT 5 NOT NULL,
	"tool_choice" text DEFAULT 'auto' NOT NULL,
	"memory_enabled" boolean DEFAULT false NOT NULL,
	"memory_window_size" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builtin_agent_tool" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "builtin_agent_tool_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"agent_id" uuid NOT NULL,
	"tool_type" text NOT NULL,
	"mcp_server_id" uuid,
	"mcp_tool_name" text,
	"skill_id" uuid,
	"builtin_tool" text,
	"data_source_id" uuid,
	"ssh_server_id" uuid,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"value_type" text DEFAULT 'string' NOT NULL,
	"options" jsonb,
	"prev_value" text,
	"description" text,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "config_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"service_type" text NOT NULL,
	"provider" text,
	"encrypted_payload" text NOT NULL,
	"metadata" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"rest_url" text,
	"agui_url" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"grid_x" integer NOT NULL,
	"grid_y" integer NOT NULL,
	"grid_w" integer NOT NULL,
	"grid_h" integer NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"slug" text,
	"layout" jsonb,
	"published_at" timestamp,
	"visibility" text DEFAULT 'private' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"provider" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"database" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"table_allowlist" jsonb,
	"table_denylist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_run_event" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"ts" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "entity_run_event_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "entity_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"parent_run_id" uuid,
	"thread_id" uuid,
	"initiator" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_source" text NOT NULL,
	"credential_id" uuid,
	"mode" text NOT NULL,
	"schedule_id" uuid,
	"status" text NOT NULL,
	"input_task" text NOT NULL,
	"input_context" jsonb,
	"input_params" jsonb,
	"output_summary" text,
	"output_artifacts" jsonb,
	"error_message" text,
	"error_details" jsonb,
	"owner_id" uuid NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"deadline" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"url" text NOT NULL,
	"headers" jsonb,
	"credential_id" uuid,
	"credential_header" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"tools" jsonb,
	"server_name" text,
	"server_version" text,
	"server_title" text,
	"server_description" text,
	"server_instructions" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"full_body" text,
	"source_label" text,
	"task" text,
	"run_id" uuid,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_boot" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "process_boot_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"hostname" text,
	"pid" integer
);
--> statement-breakpoint
CREATE TABLE "schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"entity_kind" text DEFAULT 'agent' NOT NULL,
	"credential_id" uuid,
	"source_label" text NOT NULL,
	"name" text,
	"task" text NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp,
	"interval_value" integer,
	"interval_unit" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_triggered_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "skill_file" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "skill_file_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"content_type" text,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"skill_md" text NOT NULL,
	"checksum" text,
	"source" text DEFAULT 'local' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_server" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"credential_id" uuid NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"known_host_fingerprint" text NOT NULL,
	"command_allow" jsonb,
	"command_deny" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"login_shell" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password" text,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean,
	"ban_reason" text,
	"ban_expires" timestamp,
	"org" text,
	"im_accounts" jsonb,
	"timezone" text,
	"deleted_at" timestamp,
	"deleted_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_case_result" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verification_case_result_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"case_id" bigint NOT NULL,
	"status" text NOT NULL,
	"entity_run_id" uuid,
	"input_snapshot" jsonb NOT NULL,
	"result_payload" jsonb,
	"result_truncated" boolean DEFAULT false NOT NULL,
	"assertion_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"duration_ms" integer,
	"started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "verification_case" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verification_case_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"suite_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mcp_server_id" uuid,
	"tool_name" text,
	"workflow_id" uuid,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assertions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "verification_case_target_xor" CHECK ((
        ("verification_case"."mcp_server_id" IS NOT NULL AND "verification_case"."tool_name" IS NOT NULL AND "verification_case"."workflow_id" IS NULL)
        OR
        ("verification_case"."mcp_server_id" IS NULL AND "verification_case"."tool_name" IS NULL AND "verification_case"."workflow_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "verification_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"status" text NOT NULL,
	"total_count" integer NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"errored_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"triggered_by" text NOT NULL,
	"started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "verification_suite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"timeout_sec" integer DEFAULT 300 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "verification_suite_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"spec" jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_parent_id_artifact_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."artifact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backend_thread_state" ADD CONSTRAINT "backend_thread_state_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_agent" ADD CONSTRAINT "builtin_agent_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_agent" ADD CONSTRAINT "builtin_agent_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_agent" ADD CONSTRAINT "builtin_agent_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_agent_tool" ADD CONSTRAINT "builtin_agent_tool_agent_id_builtin_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."builtin_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_agent_tool" ADD CONSTRAINT "builtin_agent_tool_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_agent_tool" ADD CONSTRAINT "builtin_agent_tool_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_agent_tool" ADD CONSTRAINT "builtin_agent_tool_data_source_id_data_source_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_agent_tool" ADD CONSTRAINT "builtin_agent_tool_ssh_server_id_ssh_server_id_fk" FOREIGN KEY ("ssh_server_id") REFERENCES "public"."ssh_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config" ADD CONSTRAINT "config_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_artifact" ADD CONSTRAINT "dashboard_artifact_dashboard_id_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboard"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_artifact" ADD CONSTRAINT "dashboard_artifact_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_parent_id_dashboard_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dashboard"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source" ADD CONSTRAINT "data_source_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source" ADD CONSTRAINT "data_source_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source" ADD CONSTRAINT "data_source_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_run_event" ADD CONSTRAINT "entity_run_event_run_id_entity_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."entity_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_run" ADD CONSTRAINT "entity_run_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_run" ADD CONSTRAINT "entity_run_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_run" ADD CONSTRAINT "entity_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_run_id_entity_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."entity_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_file" ADD CONSTRAINT "skill_file_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_server" ADD CONSTRAINT "ssh_server_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_server" ADD CONSTRAINT "ssh_server_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_server" ADD CONSTRAINT "ssh_server_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_case_result" ADD CONSTRAINT "verification_case_result_run_id_verification_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."verification_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_case_result" ADD CONSTRAINT "verification_case_result_case_id_verification_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."verification_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_case_result" ADD CONSTRAINT "verification_case_result_entity_run_id_entity_run_id_fk" FOREIGN KEY ("entity_run_id") REFERENCES "public"."entity_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_case" ADD CONSTRAINT "verification_case_suite_id_verification_suite_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."verification_suite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_case" ADD CONSTRAINT "verification_case_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_suite_id_verification_suite_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."verification_suite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_suite" ADD CONSTRAINT "verification_suite_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_parent_idx" ON "artifact" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "artifact_created_by_idx" ON "artifact" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "artifact_type_idx" ON "artifact" USING btree ("type");--> statement-breakpoint
CREATE INDEX "artifact_source_idx" ON "artifact" USING btree ("source_thread_id","source_outcome_id");--> statement-breakpoint
CREATE INDEX "artifact_workflow_id_idx" ON "artifact" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "backend_thread_state_updated_at_idx" ON "backend_thread_state" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "builtin_agent_one_supervisor_per_user_idx" ON "builtin_agent" USING btree ("created_by") WHERE "builtin_agent"."is_supervisor" = true;--> statement-breakpoint
CREATE INDEX "builtin_agent_tool_agent_idx" ON "builtin_agent_tool" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "builtin_agent_tool_mcp_server_idx" ON "builtin_agent_tool" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "builtin_agent_tool_mcp_tool_idx" ON "builtin_agent_tool" USING btree ("mcp_server_id","mcp_tool_name");--> statement-breakpoint
CREATE INDEX "builtin_agent_tool_skill_idx" ON "builtin_agent_tool" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "builtin_agent_tool_data_source_idx" ON "builtin_agent_tool" USING btree ("data_source_id");--> statement-breakpoint
CREATE INDEX "builtin_agent_tool_ssh_server_idx" ON "builtin_agent_tool" USING btree ("ssh_server_id");--> statement-breakpoint
CREATE INDEX "credential_type_idx" ON "credential" USING btree ("type");--> statement-breakpoint
CREATE INDEX "credential_provider_idx" ON "credential" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "dashboard_artifact_dashboard_idx" ON "dashboard_artifact" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "dashboard_artifact_artifact_idx" ON "dashboard_artifact" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "dashboard_parent_idx" ON "dashboard" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "dashboard_created_by_idx" ON "dashboard" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "data_source_name_unique" ON "data_source" USING btree ("name");--> statement-breakpoint
CREATE INDEX "data_source_credential_idx" ON "data_source" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "data_source_provider_idx" ON "data_source" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "entity_run_owner_idx" ON "entity_run" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "entity_run_thread_idx" ON "entity_run" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "entity_run_parent_idx" ON "entity_run" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "entity_run_status_idx" ON "entity_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "entity_run_created_at_idx" ON "entity_run" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "entity_run_schedule_idx" ON "entity_run" USING btree ("schedule_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entity_run_workflow_lookup_idx" ON "entity_run" USING btree ("entity_kind","entity_source","entity_id") WHERE "entity_run"."entity_kind" = 'workflow' AND "entity_run"."entity_source" = 'builtin';--> statement-breakpoint
CREATE INDEX "notification_owner_idx" ON "notification" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_owner_unread_idx" ON "notification" USING btree ("owner_id","read_at");--> statement-breakpoint
CREATE INDEX "schedule_owner_idx" ON "schedule" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "schedule_enabled_idx" ON "schedule" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_file_skill_path_idx" ON "skill_file" USING btree ("skill_id","path");--> statement-breakpoint
CREATE INDEX "skill_file_skill_id_idx" ON "skill_file" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_server_name_unique" ON "ssh_server" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ssh_server_credential_idx" ON "ssh_server" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_active_idx" ON "user" USING btree ("email") WHERE "user"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "verification_case_result_run_idx" ON "verification_case_result" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "verification_case_result_case_started_idx" ON "verification_case_result" USING btree ("case_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "verification_case_suite_name_idx" ON "verification_case" USING btree ("suite_id","name");--> statement-breakpoint
CREATE INDEX "verification_case_suite_idx" ON "verification_case" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX "verification_case_mcp_tool_idx" ON "verification_case" USING btree ("mcp_server_id","tool_name");--> statement-breakpoint
CREATE INDEX "verification_run_suite_started_idx" ON "verification_run" USING btree ("suite_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "verification_run_status_idx" ON "verification_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_created_by_idx" ON "workflow" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "workflow_visibility_idx" ON "workflow" USING btree ("visibility") WHERE "workflow"."visibility" = 'public';--> statement-breakpoint
CREATE INDEX "workflow_spec_gin_idx" ON "workflow" USING gin ("spec" jsonb_path_ops);