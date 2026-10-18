import { describe, it, expect } from "vitest";

import {
  buildTree,
  type SkillFileMeta,
  type TreeNode,
} from "@/components/main-panels/skills/SkillFileTree";

/** Projects a tree to indented "label" lines so ordering is assertable at a glance. */
function outline(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${"  ".repeat(depth)}${n.label}${n.kind === "dir" ? "/" : ""}`,
    ...outline(n.children, depth + 1),
  ]);
}

const f = (path: string, size = 100): SkillFileMeta => ({
  path,
  size,
  contentType: null,
});

describe("buildTree", () => {
  it("returns an empty tree when a skill has no helper files", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("keeps a single top-level file as a bare leaf", () => {
    expect(outline(buildTree([f("references/guide.md")]))).toEqual([
      "references/",
      "  guide.md",
    ]);
  });

  it("merges siblings into one directory node", () => {
    const tree = buildTree([
      f("scripts/probe.sh"),
      f("scripts/analyze.py"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
    expect(outline(tree)).toEqual(["scripts/", "  analyze.py", "  probe.sh"]);
  });

  it("nests directories to arbitrary depth", () => {
    expect(outline(buildTree([f("references/api/v1/notes.txt")]))).toEqual([
      "references/",
      "  api/",
      "    v1/",
      "      notes.txt",
    ]);
  });

  it("sorts directories before files at the same level", () => {
    const tree = buildTree([
      f("assets/zebra.txt"),
      f("assets/img/logo.png"),
      f("assets/apple.txt"),
    ]);
    // "img/" sorts after "apple" alphabetically but must still come first.
    expect(outline(tree)).toEqual([
      "assets/",
      "  img/",
      "    logo.png",
      "  apple.txt",
      "  zebra.txt",
    ]);
  });

  it("orders labels case-insensitively", () => {
    const tree = buildTree([f("references/b.md"), f("references/A.md")]);
    expect(tree[0].children.map((n) => n.label)).toEqual(["A.md", "b.md"]);
  });

  it("orders numeric suffixes by value, not lexicographically", () => {
    const tree = buildTree([
      f("references/step10.md"),
      f("references/step2.md"),
      f("references/step1.md"),
    ]);
    expect(tree[0].children.map((n) => n.label)).toEqual([
      "step1.md",
      "step2.md",
      "step10.md",
    ]);
  });

  it("groups every top-level folder as its own node", () => {
    const tree = buildTree([
      f("evals/cases.json"),
      f("assets/logo.png"),
      f("scripts/probe.sh"),
      f("references/guide.md"),
      f("lib/helper.py"),
      f("rules/style.md"),
    ]);
    expect(tree.map((n) => n.label)).toEqual([
      "assets",
      "evals",
      "lib",
      "references",
      "rules",
      "scripts",
    ]);
  });

  it("does not mutate the input listing", () => {
    const files = [f("scripts/b.sh"), f("scripts/a.sh")];
    const snapshot = [...files];
    buildTree(files);
    expect(files).toEqual(snapshot);
  });
});
