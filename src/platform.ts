// OS and architecture are closed wire enums. Unsupported platforms must send
// nothing rather than invent values that invalidate every event.

import { createRequire } from 'node:module'
import { release } from 'node:os'
import type { Debug } from './debug.ts'

/**
 * The shape this file needs from `process` (real or, in a test, a stand-in).
 * An index signature keeps callers free to hand over an object carrying
 * other process-like fields (`versions`, ...) without an excess-property error.
 */
export interface ProcessLike {
  type?: string
  [key: string]: unknown
}

export interface Platform {
  av: string
  observedVersion?: string
  os: string
  osv: string
  arch: string
}

const OS_BY_PROCESS_PLATFORM: Record<string, string> = {
  darwin: 'macos',
  win32: 'windows',
  linux: 'linux',
}

const ARCH_BY_PROCESS_ARCH: Record<string, string> = {
  arm64: 'arm64',
  x64: 'x64',
  ia32: 'x86',
}

/** §5.2 caps `av` and `osv` at 32; the schema also gives `av` `minLength: 1`. */
export function truncate32(value: string): string {
  return [...value].slice(0, 32).join('')
}

/**
 * The `electron` module, required LAZILY and inside a try/catch so the bundle
 * loads under plain `node` — which is what the conformance host runs on
 * (spec/sdk-conformance.md §5 overrides the default directory with
 * JELTO_STATE_DIR in every scenario, so this path is never taken under the
 * suite).
 *
 * spec/sdk-conformance.md §5: "main process only". `proc.type` is Electron's
 * own tag for which process this is (`'browser'` is the main process,
 * `'renderer'`/`'utility'` are not); anything else -- including plain Node,
 * where `type` is undefined -- is refused before `electron` is ever required,
 * so a renderer or a preload script cannot walk away with main-process state.
 *
 * `createRequire(import.meta.url)` anchors module resolution at THIS FILE's
 * own installed location rather than at `process.cwd()`, which a host
 * application controls and which an attacker able to influence it could use
 * to plant a fake `electron` package ahead of the real one on the resolution
 * path.
 */
export function electronApp(proc: ProcessLike = process as unknown as ProcessLike): { getPath?(name: string): string; getVersion?(): string } | null {
  if (proc.type !== 'browser') return null
  try {
    const resolve = createRequire(import.meta.url)
    const electron = resolve('electron') as { app?: { getPath?(n: string): string; getVersion?(): string } }
    return electron.app ?? null
  } catch {
    return null
  }
}

/** Raw observation: an explicit override, including empty, beats platform metadata. */
export function resolveAppVersion(env: NodeJS.ProcessEnv): string {
  if (env['JELTO_APP_VERSION'] !== undefined) return env['JELTO_APP_VERSION']
  try { return electronApp()?.getVersion?.() ?? '' } catch { return '' }
}

export function knownAppVersion(value: string): boolean {
  return /\P{White_Space}/u.test(value) && [...value].length <= 32 && !/[\uD800-\uDFFF]/u.test(value)
}

/**
 * `osv`: Electron's `process.getSystemVersion()` when the runtime has it — it
 * answers `15.1` on macOS where `os.release()` answers the Darwin kernel
 * version `24.1.0` — else `os.release()`.
 */
export function resolveOSVersion(): string {
  const electronProcess = process as NodeJS.Process & { getSystemVersion?: () => string }
  try {
    const version = electronProcess.getSystemVersion?.()
    if (typeof version === 'string' && version.trim() !== '') return truncate32(version.trim())
  } catch {
    // Swallowed: the SDK never throws into the host.
  }
  const kernel = release().trim()
  return truncate32(kernel === '' ? '0' : kernel)
}

/** `null` means: this build has no legal `os`/`arch`, and nothing may be sent. */
export function detectPlatform(env: NodeJS.ProcessEnv, log: Debug): Platform | null {
  const os = OS_BY_PROCESS_PLATFORM[process.platform]
  if (os === undefined) {
    log.log(
      `spec/wire-v1.md §5.2 \`os\` is macos|windows|linux; this build is ${process.platform}, so nothing can be sent`,
    )
    return null
  }
  const arch = ARCH_BY_PROCESS_ARCH[process.arch]
  if (arch === undefined) {
    log.log(
      `spec/wire-v1.md §5.2 \`arch\` is arm64|x64|x86; this build is ${process.arch}, so nothing can be sent`,
    )
    return null
  }
  const version = resolveAppVersion(env)
  return { av: truncate32(version) || '1.0.0', observedVersion: knownAppVersion(version) ? version : undefined, os, osv: resolveOSVersion(), arch }
}
