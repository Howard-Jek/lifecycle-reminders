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
    // Scratch written by `supabase start` — bundled third-party JS, not ours.
    "supabase/.temp/**",
  ]),
  {
    rules: {
      /**
       * Honour the `_` prefix the codebase already uses for deliberately
       * unused arguments.
       *
       * Server actions have a fixed (prevState, formData) signature whether or
       * not they read both — `signUp` now reads neither, since self-serve
       * signup is closed and it exists only to answer callers holding an old
       * action id. Renaming is not an option and deleting the parameters is not
       * either, so the convention needs to be expressible.
       */
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
