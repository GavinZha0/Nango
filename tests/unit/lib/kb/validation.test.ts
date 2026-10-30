import { describe, expect, it } from "vitest";

import {
  KB_COLLECTION_NAME_RE,
  collectionNameSchema,
  kbSlugFromFolderName,
  optionalDescriptionSchema,
} from "@/lib/kb/validation";
import { MAX_DESCRIPTION_CHARS } from "@/lib/kb/limits";

describe("kb name slug — the handle an agent echoes back", () => {
  it("accepts the shapes a folder or an author actually produces", () => {
    for (const name of ["x-manual", "2024-notes", "a", "under_score", "a".repeat(63)]) {
      expect(KB_COLLECTION_NAME_RE.test(name)).toBe(true);
    }
  });

  it("refuses what `kb_name` could never receive", () => {
    for (const name of ["X-Manual", "-manual", "_manual", "manual one", "a".repeat(64)]) {
      expect(collectionNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe("kbSlugFromFolderName — the folder pick is the whole naming step", () => {
  it("folds a human folder name into the slug", () => {
    expect(kbSlugFromFolderName("Product X Manual")).toBe("product-x-manual");
    expect(kbSlugFromFolderName("2024 Notes (draft)")).toBe("2024-notes-draft");
    // Only runs of *unsupported* characters fold; an existing hyphen is legal,
    // so the folder keeps its own punctuation where it can.
    expect(kbSlugFromFolderName("  My--Kit  ")).toBe("my--kit");
    expect(kbSlugFromFolderName("_private/notes")).toBe("private-notes");
  });

  it("cuts at the length the runtime argument enforces", () => {
    const slug = kbSlugFromFolderName(`x-${"a".repeat(80)}`);
    expect(slug).toHaveLength(63);
    expect(slug!.startsWith("x-a")).toBe(true);
  });

  it("returns null instead of inventing a name the author never picked", () => {
    // A folder of CJK or emoji prose has no ASCII slug in it, and one of pure
    // punctuation folds to nothing.
    expect(kbSlugFromFolderName("产品手册")).toBeNull();
    expect(kbSlugFromFolderName("!!!")).toBeNull();
    expect(kbSlugFromFolderName("")).toBeNull();
  });

  it("only ever returns a slug the API will accept", () => {
    for (const folder of ["Notes", "1-x", "a_b", "  spaced  name  ", "x".repeat(70)]) {
      const slug = kbSlugFromFolderName(folder);
      expect(slug).not.toBeNull();
      expect(collectionNameSchema.safeParse(slug!).success).toBe(true);
    }
  });
});

describe("collection description — optional, and empty means absent", () => {
  it("stores prose verbatim up to the ceiling", () => {
    expect(optionalDescriptionSchema.safeParse("  A manual.  ").data).toBe("A manual.");
    expect(
      optionalDescriptionSchema.safeParse("x".repeat(MAX_DESCRIPTION_CHARS + 1)).success,
    ).toBe(false);
  });

  it("turns an empty or missing one into null, which keeps the row unmounted", () => {
    expect(optionalDescriptionSchema.safeParse("").data).toBeNull();
    expect(optionalDescriptionSchema.safeParse("   ").data).toBeNull();
    expect(optionalDescriptionSchema.safeParse(undefined).success).toBe(true);
    expect(optionalDescriptionSchema.safeParse(null).data).toBeNull();
  });
});
