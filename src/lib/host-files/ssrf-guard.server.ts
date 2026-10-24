/**
 * Outbound-address guard for `download_file`. See docs/host-files.md.
 *
 * SECURITY — the caller is an LLM and the URL is attacker-chosen, so the
 * default posture is "public network only". The ranges below cover the
 * cloud instance-metadata endpoint (`169.254.169.254`), private space,
 * loopback, CGNAT, and the reserved/doc blocks that leak into sloppy
 * configs. Classification is done on the RESOLVED ADDRESS, never on the
 * hostname — `metadata.google.internal` and a `10.0.0.1` hidden behind a
 * short-lived A record are both caught by the address, not the name.
 *
 * SECURITY (accepted window): the address checked here is resolved by
 * `dns.lookup`, then the URL is handed to global `fetch`, which resolves
 * it AGAIN inside undici. A record that flips between the two lookups
 * (DNS rebinding, TTL 0) can therefore reach a private address that this
 * guard never saw. Closing it needs a custom socket `lookup`, which the
 * global `fetch` API does not expose; the operator decided the window is
 * acceptable, so it is documented rather than mitigated. `download
 * .allow_private_network` stays the loud switch for the whole question.
 */

import "server-only";

import dns from "node:dns/promises";
import { isIP } from "node:net";

export type GuardVerdict =
  | { ok: true }
  | { ok: false; code: "SSRF_BLOCKED" | "BAD_URL"; message: string };

/** Addresses a download may not reach. */
export function isRestrictedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isRestrictedV4(ip);
  if (family === 6) return isRestrictedV6(ip);
  // Not a literal — the caller resolves first, so this is defensive.
  return true;
}

function isRestrictedV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];

  return (
    a === 0 || // 0.0.0.0/8 "this host on this network"
    a === 10 || // 10/8 private
    a === 127 || // 127/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // 169.254/16 link-local + metadata IP
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 IETF assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 192.88.99/32 6to4 relay
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113/24 TEST-NET-3
    a >= 224 // 224/4 multicast + 240/4 reserved (incl. 255.255.255.255)
  );
}

function isRestrictedV6(ip: string): boolean {
  const addr = stripZone(ip.toLowerCase());

  if (addr === "::" || addr === "::1") return true;

  // IPv4-mapped forms carry the real restriction inside: `::ffff:127.0.0.1`
  // and `::ffff:7f00:1` must not slip past the v4 table.
  const dotted = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isRestrictedV4(dotted[1]!);
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    return isRestrictedV4(
      `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
    );
  }

  const hextets = expandV6(addr);
  if (hextets === null) return true; // unparseable → refuse
  const first = hextets[0]!;

  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    addr.startsWith("2001:db8:") // 2001:db8::/32 documentation
  );
}

/** Drop a `%zone` suffix and expand `::` so prefix tests are positional. */
function stripZone(ip: string): string {
  const pct = ip.indexOf("%");
  return pct === -1 ? ip : ip.slice(0, pct);
}

/** `::1` → `[0,0,0,0,0,0,0,1]`; null when the text is not a v6 address. */
function expandV6(ip: string): number[] | null {
  const withoutZone = stripZone(ip);
  if (isIP(withoutZone) !== 6) return null;
  const [head, tail] = withoutZone.split("::");
  const headParts = head === undefined || head === "" ? [] : head.split(":");
  const tailParts = tail === undefined || tail === "" ? [] : tail.split(":");

  if (!withoutZone.includes("::")) {
    return parseHextets(headParts);
  }
  if (headParts.length + tailParts.length > 7) return null;
  const parsedHead = parseHextets(headParts);
  const parsedTail = parseHextets(tailParts);
  if (parsedHead === null || parsedTail === null) return null;
  const gap = 8 - parsedHead.length - parsedTail.length;
  if (gap < 0) return null;
  return [...parsedHead, ...new Array(gap).fill(0), ...parsedTail];
}

function parseHextets(parts: string[]): number[] | null {
  const out: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out.push(Number.parseInt(part, 16));
  }
  return out;
}

/**
 * Resolve `url`'s host and refuse anything that is not public.
 * `allowPrivate` is the operator escape hatch (default off) and skips
 * resolution entirely — with it on, the guard is a no-op by design.
 */
export async function assertPublicDestination(
  url: URL,
  allowPrivate: boolean,
): Promise<GuardVerdict> {
  if (allowPrivate) return { ok: true };

  const host = stripBrackets(url.hostname);
  if (host.length === 0) {
    return { ok: false, code: "BAD_URL", message: "The URL has no host." };
  }

  if (isIP(host) !== 0) {
    if (isRestrictedAddress(host)) return blocked(host, host);
    return { ok: true };
  }

  // A name may resolve to several addresses; every one must be public,
  // otherwise a round-robin record with a private entry would sometimes
  // pass this gate and be the one undici connects to.
  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unknown";
    return {
      ok: false,
      code: "BAD_URL",
      message: `Host "${host}" did not resolve (${code}).`,
    };
  }
  if (records.length === 0) {
    return { ok: false, code: "BAD_URL", message: `Host "${host}" has no address records.` };
  }

  for (const record of records) {
    if (isRestrictedAddress(record.address)) return blocked(host, record.address);
  }
  return { ok: true };
}

function blocked(host: string, address: string): GuardVerdict {
  return {
    ok: false,
    code: "SSRF_BLOCKED",
    message:
      `"${host}" resolves to ${address}, which is not a public address. ` +
      "download_file reaches the public internet only — internal hosts, " +
      "cloud metadata, and loopback are refused. Do not retry this URL. An " +
      "admin can lift the restriction with `download.allow_private_network`.",
  };
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
