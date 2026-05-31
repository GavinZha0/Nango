/**
 * Shared Zod base shapes for data-source credential `secrets` payloads.
 */

import { z } from "zod";

/**
 * Authentication payload for traditional RDBMS connections (postgres,
 * mysql, mariadb, vertica). All four providers share this exact shape
 * — matches the `basic_auth` payload emitted by the admin
 * `CredentialFormDialog`. Each adapter maps `username` to its driver's
 * native parameter name (libpq / mysql / vertica all happen to call it
 * `user`) at connection-build time, so future drivers with different
 * conventions stay self-contained.
 *
 * Driver-specific connection options (host, port, sslmode, …) live on
 * the `data_source` row, not here.
 */
export const DatabaseConnectionBase = z.object({
  username: z.string().min(1, "username is required"),
  password: z.string().default(""),
});
