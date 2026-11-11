import { join, resolve } from 'node:path'

// ruleid: jelto-contracts-from-env-only
export const sibling = new URL('../contracts/spec/wire-v1.md', import.meta.url)
// ruleid: jelto-contracts-from-env-only
export const nested = resolve(process.cwd(), '../../jelto-contracts')
// ruleid: jelto-contracts-from-env-only
export const joined = join(process.cwd(), '..', 'contracts')
// ruleid: jelto-contracts-from-env-only
export const windows = '..\\contracts'

// ok: jelto-contracts-from-env-only
export const fromEnv = process.env.JELTO_CONTRACTS_DIR
// ok: jelto-contracts-from-env-only
export const local = join(process.cwd(), '.contracts')
// ok: jelto-contracts-from-env-only
export const vendored = new URL('../vendor/quality/quality.mk', import.meta.url)
