ALTER TABLE "eval_case_result" ADD COLUMN IF NOT EXISTS "assertion_results" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'eval_case_result' AND column_name = 'criteria_results') THEN
    UPDATE "eval_case_result" SET "assertion_results" = COALESCE("criteria_results", '[]'::jsonb);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "eval_case_result" DROP COLUMN IF EXISTS "criteria_results";--> statement-breakpoint

ALTER TABLE "web_auto_case_result" ADD COLUMN IF NOT EXISTS "assertion_results" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "web_auto_case_result" ADD COLUMN IF NOT EXISTS "score" integer;--> statement-breakpoint
ALTER TABLE "web_auto_case_result" ADD COLUMN IF NOT EXISTS "feedback" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'web_auto_case_result' AND column_name = 'verdict') THEN
    UPDATE "web_auto_case_result"
    SET
      "assertion_results" = COALESCE(verdict->'deterministic'->'results', '[]'::jsonb),
      "score" = (verdict->'llm'->>'score')::integer,
      "feedback" = verdict->'llm'->>'feedback'
    WHERE verdict IS NOT NULL;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "web_auto_case_result" DROP COLUMN IF EXISTS "verdict";
