ALTER TABLE "eval_case" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "eval_case" ADD CONSTRAINT "eval_case_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "eval_case" c SET "created_by" = s.created_by FROM "eval_suite" s WHERE c.suite_id = s.id;