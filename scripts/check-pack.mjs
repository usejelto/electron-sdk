// spec/sdk-conformance.md §3's host is a development-only entry point (see
// build.mjs and ./conformance-host's own comment): dist/conformance-host.mjs
// must never leave this repo inside the published npm tarball. This is run
// from the Makefile's `package` target, before `npm pack` writes one for real.
import { execFileSync } from 'node:child_process'

const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' })
const [report] = JSON.parse(output)
if (report === undefined) {
  console.error('package: `npm pack --dry-run --json` produced no report')
  process.exit(1)
}

const offenders = report.files
  .map((entry) => entry.path)
  .filter((path) => path.includes('conformance-host'))

if (offenders.length > 0) {
  console.error(`package: the npm tarball must not ship conformance-host, but found: ${offenders.join(', ')}`)
  process.exit(1)
}

console.log(`package: npm tarball excludes conformance-host (${report.files.length} files packed)`)
