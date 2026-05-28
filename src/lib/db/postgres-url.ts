/**
 * Build the Nango Postgres connection URL from environment variables.
 */
export function getPostgresUrl(): string {
  const url: string | undefined = process.env.POSTGRES_URL;
  if (url && url.trim()) return url;

  const user: string = process.env.POSTGRES_USER || "nango";
  const password: string = process.env.POSTGRES_PASSWORD || "nango";
  const host: string = process.env.POSTGRES_HOST || "localhost";
  const port: string = process.env.POSTGRES_PORT || "5433";
  const db: string = process.env.POSTGRES_DB || "nango";

  return `postgres://${user}:${password}@${host}:${port}/${db}`;
}
