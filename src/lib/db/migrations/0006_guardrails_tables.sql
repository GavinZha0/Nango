CREATE TABLE "safety_policy" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "safety_policy_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"policy_type" text DEFAULT 'regex' NOT NULL,
	"action" text DEFAULT 'redact' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"policy_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "safety_policy_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tool_risk_override" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tool_risk_override_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"mcp_server_id" uuid,
	"tool_name" text NOT NULL,
	"risk_level" text,
	"require_approval" text DEFAULT 'inherit' NOT NULL,
	"headless_allowed" boolean,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "safety_policy" ADD CONSTRAINT "safety_policy_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_policy" ADD CONSTRAINT "safety_policy_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_risk_override" ADD CONSTRAINT "tool_risk_override_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_risk_override" ADD CONSTRAINT "tool_risk_override_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_risk_override" ADD CONSTRAINT "tool_risk_override_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "safety_policy_cat_enabled_idx" ON "safety_policy" USING btree ("category","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_risk_override_source_server_tool_idx" ON "tool_risk_override" USING btree ("source","mcp_server_id","tool_name");