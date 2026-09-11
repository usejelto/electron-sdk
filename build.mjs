// Build for @jelto/electron. Three artefacts, no framework:
//
//   dist/index.mjs / index.cjs   the SDK a customer links: TypeScript, main
//                                process only, Node >= 18, no native addon.
//                                `electron` is EXTERNAL --
//                                the SDK requires it lazily and only to resolve
//                                §5's default state directory, so the bundle
//                                loads under plain node too, which is what the
//                                conformance host runs on.
//   dist/index.d.ts              emitted by tsc, not by esbuild.
//   dist/conformance-host.mjs    spec/sdk-conformance.md §3's host. The
//                                committed ./conformance-host wrapper execs it.
//
// It is deliberately NOT minified: a reproducible artefact a reader can check
// is wanted here, and nothing in this bundle is served over a wire with a
// byte budget (that is the web snippet, a separate artefact).
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  minify: false,
  sourcemap: false,
  external: ['electron'],
  absWorkingDir: root,
  logLevel: 'warning',
}

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.mjs', format: 'esm' })
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs', format: 'cjs' })
await build({ ...common, entryPoints: ['host/main.ts'], outfile: 'dist/conformance-host.mjs', format: 'esm' })

// Types. tsc is the only thing that can emit them; esbuild erases them.
execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })

console.log('built dist/index.mjs, dist/index.cjs, dist/index.d.ts, dist/conformance-host.mjs')
