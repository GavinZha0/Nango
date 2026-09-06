import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveInput } from "@/lib/assertions/variable-resolver";

describe("variable resolver — {{$int}} bounds defense (F19)", () => {
  it("1. swapped bounds {{$int(10,5)}} normalize instead of throwing", () => {
    const resolved = resolveInput({ n: "{{$int(10,5)}}" });
    expect(typeof resolved.n).toBe("number");
    expect(resolved.n as number).toBeGreaterThanOrEqual(5);
    expect(resolved.n as number).toBeLessThanOrEqual(10);
  });

  it("2. single negative bound clamps to a valid range instead of throwing", () => {
    const resolved = resolveInput({ n: "{{$int(-3)}}" });
    expect(resolved.n).toBe(0);
  });

  it("3. normal bounds keep working (regression)", () => {
    for (let i = 0; i < 20; i++) {
      const resolved = resolveInput({ n: "{{$int(1,3)}}" });
      expect(resolved.n as number).toBeGreaterThanOrEqual(1);
      expect(resolved.n as number).toBeLessThanOrEqual(3);
    }
  });

  it("4. non-token values pass through untouched", () => {
    const resolved = resolveInput({ note: "hello world", n: 7 });
    expect(resolved).toEqual({ note: "hello world", n: 7 });
  });
});
