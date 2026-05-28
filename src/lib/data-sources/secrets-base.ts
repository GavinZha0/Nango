/**
 * Shared Zod base shapes for data-source credential `secrets` payloads.
 */

import { z } from "zod";

/**
 * Authentication payload for traditional RDBMS connections (postgres,
 * mysql, mariadb, vertica, …). All four providers use the same shape
 * — driver-specific connection options live on the data_source row,
 * not here.
 *
 * Future categories (object storage with access-key / secret-key,
 * OAuth client / secret, …) get their own base in this file.
 */
/**
 * Single source of truth: matches the basic_auth payload shape
 * emitted by the admin CredentialFormDialog (`{username, password}`).
 * Each adapter maps `username` → its driver's native parameter name
 * (libpq / mysql / vertica all happen to call it `user`) at the
 * connection-build site, so future drivers with different
 * conventions stay self-contained.
 */
export const DatabaseConnectionBase = z.object({
  username: z.string().min(1, "username is required"),
  password: z.string().default(""),
});
