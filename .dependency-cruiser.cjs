// dependency-cruiser: the import rules the package layout relies on. `make
// boundaries` runs it over src/, host/, scripts/ and build.mjs. Every rule says
// why it exists; an exception narrows the rule to the one path it concerns,
// with the reason.
//
// src/ is the SDK a customer links (package.json `exports`, bundled by
// build.mjs). host/ is the development-only conformance host and scripts/ the
// packaging checks; neither ships.

// The SDK's tests live beside it in src/; they may use devDependencies.
const tests = '\\.test\\.ts$'

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A cycle makes module initialization order matter.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Every import resolves; a typo or a removed file fails here rather than in a customer build.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      comment: 'A package used directly is declared in package.json, not borrowed from another package.',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'shipped-code-uses-runtime-dependencies',
      severity: 'error',
      comment: 'src/ is what the package ships, and an install of it has no devDependencies; its tests may use them.',
      from: { path: '^src/', pathNot: tests },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'sdk-not-host-or-scripts',
      severity: 'error',
      comment: 'The SDK never imports the conformance host, the packaging scripts or the build script, none of which ships.',
      from: { path: '^src/' },
      to: { path: '^(host/|scripts/|build\\.mjs$)' },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', '^dist/'] },
    exclude: { path: '^(vendor|release-artifacts|\\.contracts)/' },
    tsConfig: { fileName: 'tsconfig.host.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      // Node.js's own conditions: the ones the tests and the host run under.
      conditionNames: ['import', 'node', 'default'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
}
