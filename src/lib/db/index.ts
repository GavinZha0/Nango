import { drizzle } from "drizzle-orm/node-postgres";

import { getPostgresUrl } from "./postgres-url";

export const db = drizzle(getPostgresUrl());
