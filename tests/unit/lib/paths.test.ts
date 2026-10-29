import { describe, expect, it } from "vitest";

import { getBaseName, getExtension, getParentPath } from "@/lib/paths";

describe("path primitives", () => {
  it("splits a stored path into parent and base", () => {
    expect(getParentPath("references/sub/guide.md")).toBe("references/sub");
    expect(getParentPath("guide.md")).toBe("");
    expect(getBaseName("references/sub/guide.md")).toBe("guide.md");
    expect(getBaseName("guide.md")).toBe("guide.md");
  });

  it("takes only the trailing extension", () => {
    expect(getExtension("references/a.b.c.txt")).toBe("txt");
    expect(getExtension("README.MD")).toBe("md");
  });

  it("reports no extension for dotfiles, hidden names, and trailing dots", () => {
    expect(getExtension("references/README")).toBe("");
    expect(getExtension("assets/.env")).toBe("");
    expect(getExtension("references/trailing.")).toBe("");
  });
});
