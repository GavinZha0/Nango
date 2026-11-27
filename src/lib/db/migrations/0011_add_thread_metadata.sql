CREATE TABLE "thread_metadata" (
	"owner_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"pinned_at" timestamp with time zone,
	"custom_title" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "thread_metadata_owner_id_thread_id_pk" PRIMARY KEY("owner_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "thread_metadata" ADD CONSTRAINT "thread_metadata_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_metadata_owner_pinned_idx" ON "thread_metadata" USING btree ("owner_id","pinned_at" DESC NULLS LAST) WHERE "thread_metadata"."pinned_at" IS NOT NULL;