ALTER TABLE "web_auto_case" ADD COLUMN IF NOT EXISTS "input" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'web_auto_case' AND column_name = 'script_content') THEN
    UPDATE "web_auto_case" SET "input" = json_build_object(
      'script', COALESCE("script_content", ''),
      'steps', COALESCE("description", '')
    );
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "web_auto_case" DROP COLUMN IF EXISTS "script_content";--> statement-breakpoint
ALTER TABLE "web_auto_case" DROP COLUMN IF EXISTS "description";
