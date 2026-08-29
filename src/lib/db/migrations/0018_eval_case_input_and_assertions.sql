ALTER TABLE "eval_case" ADD COLUMN IF NOT EXISTS "input" jsonb DEFAULT '{"turns":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_case" ADD COLUMN IF NOT EXISTS "assertions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'eval_case' AND column_name = 'turns') THEN
    UPDATE "eval_case" SET "input" = json_build_object('turns', COALESCE("turns", '[]'::jsonb));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'eval_case' AND column_name = 'criteria') THEN
    UPDATE "eval_case" SET "assertions" = (
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM (
        SELECT json_build_object('type', 'llm_judge', 'expectation', criteria->>'expectation') AS elem WHERE criteria->>'expectation' IS NOT NULL
        UNION ALL
        SELECT json_build_object('type', 'metric', 'metric', 'duration_ms', 'operator', '<=', 'threshold', (criteria->>'max_duration_s')::numeric * 1000) AS elem WHERE criteria->>'max_duration_s' IS NOT NULL
        UNION ALL
        SELECT json_build_object('type', 'metric', 'metric', 'output_tokens', 'operator', '<=', 'threshold', (criteria->>'max_output_tokens')::numeric) AS elem WHERE criteria->>'max_output_tokens' IS NOT NULL
        UNION ALL
        SELECT json_build_object('type', 'metric', 'metric', 'total_tool_calls', 'operator', '<=', 'threshold', (criteria->>'max_tool_calls')::numeric) AS elem WHERE criteria->>'max_tool_calls' IS NOT NULL
      ) t
    );
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "eval_case" DROP COLUMN IF EXISTS "turns";--> statement-breakpoint
ALTER TABLE "eval_case" DROP COLUMN IF EXISTS "criteria";
