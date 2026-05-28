import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

// Drizzle Kit runs this config file via tsx/jiti at the project root,
// outside Next.js's path-alias resolver. The relative import is
// intentional — `@/` would not resolve here.
import { getPostgresUrl } from "./src/lib/db/postgres-url";

dotenv.config({ path: ".env" });

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./src/lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: getPostgresUrl(),
  },
});
