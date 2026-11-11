// Knip: files nothing imports, unused exports and dependencies, and
// dependencies used but not declared. `make deadcode` runs it. Tests count as
// users. Everything a tool loads without an import is named here, with why.
//
// Knip already reads these from package.json: `exports` (src/index.ts, mapped
// back from dist/ through tsconfig.json), the build script and the test files
// the `node --test` scripts name. src/index.ts's exports are the public API, so
// they are never reported unused.
import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: [
    // The development-only conformance host, which build.mjs bundles with
    // esbuild into dist/conformance-host.mjs for ./conformance-host to run.
    'host/main.ts',
    // The tarball check the Makefile's `package` target runs before npm pack.
    'scripts/check-pack.mjs',
    // The opengrep rule test cases, which `opengrep test .opengrep` (make sast)
    // pairs with the rule of the same name instead of importing them.
    '.opengrep/*.{ts,mjs}',
  ],
  // The Makefile runs dependency-cruiser (`make boundaries`) and Prettier
  // (`make format-check`); Knip reads package.json scripts, not the Makefile.
  ignoreDependencies: ['dependency-cruiser', 'prettier'],
}

export default config
