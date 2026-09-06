-- Denormalized display snapshot of the MCP server name bound at suite
-- creation. Survives server deletion so detached suites (mcp_server_id
-- NULL after the 0020 FK switch) still group and display under their
-- server's name in the verification left panel.

ALTER TABLE "verification_suite" ADD COLUMN "mcp_server_name" text;--> statement-breakpoint

-- Backfill existing suites from their (still-live) server rows.
UPDATE "verification_suite"
SET "mcp_server_name" = (
  SELECT COALESCE("mcp_server"."server_title", "mcp_server"."name")
  FROM "mcp_server"
  WHERE "mcp_server"."id" = "verification_suite"."mcp_server_id"
)
WHERE "mcp_server_name" IS NULL AND "mcp_server_id" IS NOT NULL;
