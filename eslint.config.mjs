import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Project-wide rules.
    rules: {
      // Ban `as BaseEvent` and `as BaseEvent & {...}` casts on the
      // AG-UI event surface. Use the typed `AgUiEvent` discriminated
      // union instead — see `docs/runner-events.md` §11. The two
      // selectors cover the bare cast and the intersection-cast
      // pattern that pre-migration code used to peek at per-event
      // fields.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression > TSTypeReference[typeName.name='BaseEvent']",
          message:
            "Avoid `as BaseEvent`. Type the value as `AgUiEvent` (the discriminated union from @/lib/copilot/index.server) and switch on `event.type` for narrowing. See docs/runner-events.md §11.",
        },
        {
          selector:
            "TSAsExpression > TSIntersectionType > TSTypeReference[typeName.name='BaseEvent']",
          message:
            "Avoid `as BaseEvent & {...}`. Type the value as `AgUiEvent` and switch on `event.type` for per-variant field access. See docs/runner-events.md §11.",
        },
      ],
    },
  },
]);

export default eslintConfig;
