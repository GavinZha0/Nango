/**
 * Commitlint configuration — enforces Conventional Commits.
 *
 * Used by:
 *   - .husky/commit-msg (local enforcement on `git commit`)
 *   - GitHub PR title check (via amannn/action-semantic-pull-request)
 *
 * Allowed types match .gitmessage and CONTRIBUTING.md.
 */
/** @type {import("@commitlint/types").UserConfig} */
const config = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "refactor",
        "style",
        "docs",
        "test",
        "chore",
        "perf",
        "build",
        "ci",
        "revert",
      ],
    ],
    "subject-case": [0],
    "header-max-length": [2, "always", 100],
  },
};

export default config;
