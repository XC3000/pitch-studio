import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Tenant isolation: raw db client only inside src/db — everything else
  // must use forOrg() from @/db/scoped so queries are always org-scoped.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/client", "**/db/client"],
              message:
                "Import forOrg() from @/db/scoped instead — direct db access bypasses tenant isolation.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Static design mocks, not app code
    "design-reference/**",
  ]),
]);

export default eslintConfig;
