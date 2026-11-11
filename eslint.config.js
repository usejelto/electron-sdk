// ESLint for the SDK source, the conformance host, their tests and the build
// scripts. `make lint` runs it; `tsc` (`npm run check`) owns type errors, so
// this config adds the recommended JavaScript and TypeScript rules on top.
import js from '@eslint/js'
import globals from 'globals'
import ts from 'typescript-eslint'

export default ts.config(
  // Build output, release staging, the contracts checkout conformance runs
  // against, and vendored snapshots (their producers lint them).
  { ignores: ['dist/', 'release-artifacts/', '.contracts/', 'vendor/'] },
  js.configs.recommended,
  ts.configs.recommended,
  {
    // Node scripts and configuration that run at build or package time, and
    // the opengrep rule test cases, written as Node modules.
    files: ['build.mjs', 'scripts/**', '.opengrep/**', '*.config.js', '*.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // dependency-cruiser reads its configuration as CommonJS.
    files: ['.dependency-cruiser.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
)
