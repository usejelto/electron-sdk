// OS and architecture are closed wire enums. Unsupported platforms must send
// nothing rather than invent values that invalidate every event.

import { createRequire } from 'node:module'
import { release } from 'node:os'
import { join } from 'node:path'
import type { Debug } from './debug.ts'

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
 * suite). `createRequire` rather than a bare `require`/`import.meta.url`,
 * because `build.mjs` emits both a CJS and an ESM bundle from this one source
 * and only one of those two spellings exists in each.
 */
export function electronApp(): { getPath?(name: string): string; getVersion?(): string } | null {
  try {
    const resolve = createRequire(join(process.cwd(), 'jelto-electron-resolver.cjs'))
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
    // Swallowed: RFC-0001 §8.3 item 10.
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
