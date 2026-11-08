/**
 * Dynamic loopback port discovery for Nango Desktop.
 *
 * Probes preferred ports for the embedded PostgreSQL 18 instance (default 15432)
 * and the Next.js standalone server (default 9300), automatically advancing to
 * the next free port on conflict and keeping `BETTER_AUTH_URL` synchronized.
 *
 * See docs/desktop-architecture.md.
 */

import net from "node:net";

export const DEFAULT_DESKTOP_PG_PORT = 15432;
export const DEFAULT_DESKTOP_APP_PORT = 9300;
export const DEFAULT_LOOPBACK_HOST = "127.0.0.1";

/**
 * Test whether a TCP port is currently free to bind on `host`.
 */
export function isPortAvailable(
  port: number,
  host: string = DEFAULT_LOOPBACK_HOST,
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(port, host, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

export interface FindPortOptions {
  host?: string;
  maxAttempts?: number;
  excludePorts?: ReadonlySet<number>;
}

/**
 * Find the first available TCP port starting at `preferredPort`.
 */
export async function findAvailablePort(
  preferredPort: number,
  opts?: FindPortOptions,
): Promise<number> {
  const host = opts?.host ?? DEFAULT_LOOPBACK_HOST;
  const maxAttempts = opts?.maxAttempts ?? 50;
  const exclude = opts?.excludePorts;

  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
    throw new Error(`Invalid preferredPort: ${preferredPort}. Must be an integer in 1024..65535.`);
  }

  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = preferredPort + offset;
    if (candidate > 65535) break;
    if (exclude?.has(candidate)) continue;

    if (await isPortAvailable(candidate, host)) {
      return candidate;
    }
  }

  throw new Error(
    `No available port found on ${host} in range ${preferredPort}..${Math.min(65535, preferredPort + maxAttempts - 1)}.`,
  );
}

export interface DesktopPortAllocation {
  pgPort: number;
  appPort: number;
  betterAuthUrl: string;
}

/**
 * Allocate non-overlapping loopback ports for PostgreSQL and Next.js,
 * and derive the matching `BETTER_AUTH_URL` origin.
 */
export async function resolveDesktopPorts(opts?: {
  preferredPgPort?: number;
  preferredAppPort?: number;
  host?: string;
}): Promise<DesktopPortAllocation> {
  const host = opts?.host ?? DEFAULT_LOOPBACK_HOST;
  const preferredPgPort = opts?.preferredPgPort ?? DEFAULT_DESKTOP_PG_PORT;
  const preferredAppPort = opts?.preferredAppPort ?? DEFAULT_DESKTOP_APP_PORT;

  const pgPort = await findAvailablePort(preferredPgPort, { host });
  const appPort = await findAvailablePort(preferredAppPort, {
    host,
    excludePorts: new Set([pgPort]),
  });

  return {
    pgPort,
    appPort,
    betterAuthUrl: `http://${host}:${appPort}`,
  };
}
