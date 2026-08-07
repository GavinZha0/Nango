-- Purge obsolete sandbox configuration parameters from config table
DELETE FROM "config" WHERE "key" IN (
  'sandbox.image',
  'sandbox.runtime',
  'sandbox.allow_insecure',
  'sandbox.service.url',
  'sandbox.service.api_key',
  'sandbox.service.provider'
);

-- Reconcile sandbox.mode options and update invalid mode values to 'service'
UPDATE "config"
SET "options" = '["subprocess","service"]'::json,
    "value" = CASE WHEN "value" NOT IN ('subprocess', 'service') THEN 'service' ELSE "value" END
WHERE "key" = 'sandbox.mode';
