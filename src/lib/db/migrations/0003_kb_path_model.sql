DROP TABLE "kb_page";
--> statement-breakpoint
DROP TABLE "kb_group";
--> statement-breakpoint
CREATE TABLE "kb_page" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "kb_page_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"collection_id" uuid NOT NULL,
	"path" text NOT NULL,
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
ALTER TABLE "kb_page" ADD CONSTRAINT "kb_page_collection_id_kb_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."kb_collection"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page" ADD CONSTRAINT "kb_page_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page" ADD CONSTRAINT "kb_page_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "kb_page_collection_path_idx" ON "kb_page" USING btree ("collection_id","path");