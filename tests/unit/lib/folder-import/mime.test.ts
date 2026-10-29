import { describe, expect, it } from "vitest";

import { guessContentType } from "@/lib/folder-import/mime";

describe("guessContentType", () => {
  it("maps image extensions so the editor can preview them", () => {
    expect(guessContentType("assets/logo.png")).toBe("image/png");
    expect(guessContentType("assets/photo.jpeg")).toBe("image/jpeg");
    expect(guessContentType("assets/photo.jpg")).toBe("image/jpeg");
    expect(guessContentType("assets/anim.gif")).toBe("image/gif");
    expect(guessContentType("assets/modern.webp")).toBe("image/webp");
  });

  it("maps text and document extensions", () => {
    expect(guessContentType("references/guide.md")).toBe("text/markdown");
    expect(guessContentType("scripts/run.py")).toBe("text/x-python");
    expect(guessContentType("scripts/probe.sh")).toBe("text/x-shellscript");
    expect(guessContentType("evals/case.json")).toBe("application/json");
    expect(guessContentType("assets/spec.pdf")).toBe("application/pdf");
  });

  it("is case-insensitive on the extension", () => {
    expect(guessContentType("assets/LOGO.PNG")).toBe("image/png");
    expect(guessContentType("assets/Photo.JpEg")).toBe("image/jpeg");
  });

  it("reads the extension off the basename, not a dotted directory", () => {
    expect(guessContentType("assets/v1.2/logo.png")).toBe("image/png");
    // The directory looks like it has an extension; the file has none.
    expect(guessContentType("assets/v1.2/README")).toBeNull();
  });

  it("returns null for unknown or absent extensions", () => {
    expect(guessContentType("assets/mystery.bin")).toBeNull();
    expect(guessContentType("assets/archive.tar.gz")).toBeNull();
    expect(guessContentType("references/README")).toBeNull();
    expect(guessContentType("references/trailing.")).toBeNull();
    // A leading dot is part of the name, not an extension separator.
    expect(guessContentType("assets/.env")).toBeNull();
  });

  it("never returns a type the browser would render as markup", () => {
    // CONTRACT: these reach the editor as a `data:` URL offered both as an
    // <img src> and a download href, so they are excluded by design.
    expect(guessContentType("assets/page.html")).toBeNull();
    expect(guessContentType("assets/page.htm")).toBeNull();
    expect(guessContentType("assets/icon.svg")).toBeNull();
  });
});
