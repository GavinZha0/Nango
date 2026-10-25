CREATE TABLE "kb_collection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_group" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "kb_group_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"collection_id" uuid NOT NULL,
	"parent_id" bigint,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "kb_group_not_self_parent_check" CHECK ("kb_group"."id" <> "kb_group"."parent_id")
);
--> statement-breakpoint
CREATE TABLE "kb_page" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "kb_page_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"collection_id" uuid NOT NULL,
	"group_id" bigint,
	"name" text NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"content_type" text DEFAULT 'text/markdown' NOT NULL,
	"size" integer NOT NULL,
	"source_ref" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "kb_page_content_type_check" CHECK ("kb_page"."content_type" IN ('text/markdown', 'text/plain', 'text/csv', 'application/json', 'text/yaml', 'text/xml'))
);
--> statement-breakpoint
ALTER TABLE "builtin_agent_tool" ADD COLUMN "kb_collection_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_collection" ADD CONSTRAINT "kb_collection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_collection" ADD CONSTRAINT "kb_collection_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_group" ADD CONSTRAINT "kb_group_collection_id_kb_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."kb_collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_group" ADD CONSTRAINT "kb_group_parent_id_kb_group_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."kb_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page" ADD CONSTRAINT "kb_page_collection_id_kb_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."kb_collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page" ADD CONSTRAINT "kb_page_group_id_kb_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."kb_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page" ADD CONSTRAINT "kb_page_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page" ADD CONSTRAINT "kb_page_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_collection_name_unique" ON "kb_collection" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_group_collection_name_idx" ON "kb_group" USING btree ("collection_id","name");--> statement-breakpoint
CREATE INDEX "kb_group_collection_parent_idx" ON "kb_group" USING btree ("collection_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_page_collection_name_idx" ON "kb_page" USING btree ("collection_id","name");--> statement-breakpoint
CREATE INDEX "kb_page_collection_group_idx" ON "kb_page" USING btree ("collection_id","group_id");--> statement-breakpoint
ALTER TABLE "builtin_agent_tool" ADD CONSTRAINT "builtin_agent_tool_kb_collection_id_kb_collection_id_fk" FOREIGN KEY ("kb_collection_id") REFERENCES "public"."kb_collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builtin_agent_tool_kb_collection_idx" ON "builtin_agent_tool" USING btree ("kb_collection_id");