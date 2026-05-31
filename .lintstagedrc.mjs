/**
 * lint-staged configuration.
 *
 * Pre-commit hook (.husky/pre-commit) → `pnpm exec lint-staged` → this file.
 *
 * The function form is important for `tsc --noEmit`: it tells lint-staged
 * NOT to append the staged file list to the command. tsc reads tsconfig.json
 * and works on the whole project graph; passing individual filenames would
 * make it skip tsconfig and produce wrong errors.
 */
/** @type {import("lint-staged").Configuration} */
const config = {
  // Lint and auto-fix staged JS / TS files.
  "*.{js,jsx,ts,tsx,mjs,cjs}": [
    "eslint --fix",
    "node scripts/check-comment-rules.mjs",
  ],

  // Whole-project type-check, triggered only when any TS file is staged.
  "*.{ts,tsx}": () => "tsc --noEmit",
};

export default config;
