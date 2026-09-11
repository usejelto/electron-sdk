// Run spec/sdk-conformance.md §3 commands against the SDK entry point.
// The wrapper execs this bundle so the runner owns the SDK process PID.
// This file owns environment, I/O, and exit; dispatch.ts owns command parsing.

import { createInterface } from 'node:readline'
import { createSdk } from '../src/index.ts'
import { parseInstant } from '../src/instant.ts'
import { createDispatcher, type HostSdk } from './dispatch.ts'
import { encodeReply, writeLine } from './reply.ts'

// The only lines this file writes to stderr are the fatal misconfigurations
// below, each of them followed by exit 2. Everything else on stderr is the
// SDK's own debug output, because C10 asserts that stderr is byte-empty without
// JELTO_DEBUG=1 and a chatty host would fail that row for the SDK.
function fatal(message: string): never {
  process.stderr.write(`conformance-host: ${message}\n`)
  process.exit(2)
}

function build(env: NodeJS.ProcessEnv): HostSdk {
  // §3's table: both of these are required, and a host without them "has
  // nothing to be conformant against". The SDK checks them too -- `createSdk`
  // throws -- and this is the check that turns either into an exit code the
  // runner can read.
  if (!env['JELTO_ENDPOINT']) {
    fatal('JELTO_ENDPOINT is required (spec/sdk-conformance.md §3)')
  }
  if (!env['JELTO_STATE_DIR']) {
    fatal('JELTO_STATE_DIR is required (spec/sdk-conformance.md §3)')
  }
  // §3.1 (v0.14): the host checks JELTO_NOW's syntax before the first command
  // and exits 2 on garbage, so a malformed pin never runs a scenario on the
  // real clock. It asks the SDK's OWN parser rather than carrying a second
  // grammar -- the reason this host used to leave the variable unread was
  // that a host-side parser could reject a value the SDK accepts, and using
  // the same function is what makes that impossible. The SDK still parses it
  // again inside createSdk; the check here is the one the runner can observe.
  const pin = env['JELTO_NOW']
  if (pin !== undefined && parseInstant(pin) === null) {
    fatal(`JELTO_NOW=${JSON.stringify(pin)} is not a whole number of milliseconds (spec/sdk-conformance.md §3.1)`)
  }
  try {
    // The rest of §3's environment goes to the SDK unread by the host:
    // JELTO_DEBUG turns on the debug payload printing, JELTO_MOCK is forwarded
    // verbatim as `X-Mock`, and JELTO_CLIENT_VERSION replaces `v` -- the empty
    // string included, which is why the host must not test any of them for
    // emptiness on the way past.
    return createSdk(env, process.stderr)
  } catch (err) {
    return fatal(err instanceof Error ? err.message : String(err))
  }
}

const sdk = build(process.env)

// C4c kills the host mid-run and the runner closes stdin on the way out, so a
// write can land on a pipe with no reader. That is the harness working, not a
// fault: an unhandled 'error' event here would turn it into a crash and a
// non-zero exit code.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

const dispatcher = createDispatcher(sdk)

// readline's async iterator pauses the stream while the loop body is awaited,
// which is the property that matters: `sleep 25200000` must not have the next
// command read out from under it, and no reply may be written before the reply
// to the command in front of it.
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const rawLine of rl) {
  const line = rawLine.trim()
  if (line === '' || line.startsWith('#')) {
    continue
  }
  const outcome = await dispatcher.dispatch(line)
  // Awaited, not fired: stdout to a pipe is asynchronous on macOS, and an
  // unflushed reply is a reply the runner attributes to the wrong command or
  // never sees at all.
  await writeLine(process.stdout, encodeReply(outcome.reply))
  if (outcome.terminate) {
    // `exit` has already run the termination flush inside dispatch,
    // and its reply is now on the wire. C1 measures this whole path at under
    // one second with a thousand events queued, so the process ends here rather
    // than waiting to discover whether anything is still holding the loop open.
    rl.close()
    process.exit(0)
  }
}

// EOF on stdin is a termination too, and refhost answers it with a reply of the
// same shape. The runner only closes stdin when it is already tearing the host
// down, so this line usually goes nowhere -- writeLine swallows that.
await writeLine(process.stdout, encodeReply({ cmd: 'eof', ok: true }))
try {
  await sdk.stop()
} catch {
  // The termination flush is best effort by definition, and there is no
  // longer anyone to report to: stdin is closed and the exit code is the only
  // channel left.
}
process.exit(0)
