import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

import {
  assertPublicDestination,
  isRestrictedAddress,
} from "@/lib/host-files/ssrf-guard.server";

function url(host: string, pathname = "/file"): URL {
  return new URL(`https://${host}${pathname}`);
}

beforeEach(() => {
  lookupMock.mockReset();
});

describe("isRestrictedAddress — IPv4", () => {
  it("blocks the ranges an agent can be steered into", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isRestrictedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public space, including the range edges", () => {
    for (const ip of ["100.128.0.1", "172.15.0.1", "172.32.0.1", "8.8.8.8", "93.184.216.34"]) {
      expect(isRestrictedAddress(ip), ip).toBe(false);
    }
  });
});

describe("isRestrictedAddress — IPv6", () => {
  it("blocks loopback, link-local, ULA, multicast and doc space", () => {
    for (const ip of [
      "::",
      "::1",
      "fe80::1",
      "febf::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "2001:db8::1",
    ]) {
      expect(isRestrictedAddress(ip), ip).toBe(true);
    }
  });

  it("classifies the address carried inside an IPv4-mapped form", () => {
    // `::ffff:127.0.0.1` and its hex spelling both have to meet the v4
    // table, or a metadata address hides behind six colons.
    expect(isRestrictedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isRestrictedAddress("::ffff:7f00:1")).toBe(true);
    expect(isRestrictedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isRestrictedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows public global space and a zone id", () => {
    expect(isRestrictedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isRestrictedAddress("fe80::1%eth0")).toBe(true);
  });

  it("treats anything unparseable as restricted", () => {
    expect(isRestrictedAddress("not-an-ip")).toBe(true);
    expect(isRestrictedAddress(":::1")).toBe(true);
  });
});

describe("assertPublicDestination", () => {
  it("skips the guard entirely when the operator lifted it", async () => {
    const verdict = await assertPublicDestination(url("169.254.169.254"), true);
    expect(verdict.ok).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks a private literal without resolving", async () => {
    const verdict = await assertPublicDestination(url("127.0.0.1"), false);
    expect(!verdict.ok && verdict.code).toBe("SSRF_BLOCKED");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks the cloud metadata address", async () => {
    const verdict = await assertPublicDestination(url("169.254.169.254"), false);
    expect(!verdict.ok && verdict.code).toBe("SSRF_BLOCKED");
    if (!verdict.ok) expect(verdict.message).toMatch(/public internet/);
  });

  it("resolves a name and accepts an all-public answer", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    expect((await assertPublicDestination(url("example.com"), false)).ok).toBe(true);
    expect(lookupMock).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
  });

  it("rejects a name with any private record in the set", async () => {
    // A round-robin zone that mixes public and internal answers must not
    // get to choose which one undici connects to.
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    const verdict = await assertPublicDestination(url("mixed.example"), false);
    expect(!verdict.ok && verdict.code).toBe("SSRF_BLOCKED");
    if (!verdict.ok) expect(verdict.message).toContain("10.0.0.5");
  });

  it("reports an internal hostname by the name it resolves", async () => {
    lookupMock.mockResolvedValue([{ address: "::1", family: 6 }]);
    const verdict = await assertPublicDestination(url("localhost"), false);
    expect(!verdict.ok && verdict.code).toBe("SSRF_BLOCKED");
  });

  it("maps resolution failure to BAD_URL, not SSRF_BLOCKED", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("no answer"), { code: "ENOTFOUND" }));
    const verdict = await assertPublicDestination(url("nope.invalid"), false);
    expect(!verdict.ok && verdict.code).toBe("BAD_URL");
    if (!verdict.ok) expect(verdict.message).toMatch(/ENOTFOUND/);
  });

  it("rejects a URL with no host", async () => {
    // A hand-built URL rather than `new URL("https:///…")`, which the
    // WHATWG parser rewrites into a host rather than failing.
    const verdict = await assertPublicDestination({ hostname: "" } as URL, false);
    expect(!verdict.ok && verdict.code).toBe("BAD_URL");
  });

  it("accepts a bracketed global IPv6 literal", async () => {
    const verdict = await assertPublicDestination(url("[2606:4700:4700::1111]"), false);
    expect(verdict.ok).toBe(true);
  });
});
