UPDATE "artifact" SET "name" = 'Slides' WHERE "parent_id" IS NULL AND "kind" = 'folder' AND "name" = 'PPT';
--> statement-breakpoint
UPDATE "artifact" SET "type" = 'slide' WHERE "type" = 'ppt';