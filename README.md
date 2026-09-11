# @jelto/electron

Jelto analytics for Electron's main process. Requires Node.js 18 or later and has
no native addons or runtime dependencies.

## Install locally

Version 1.0.0 is prepared for release; registry publication is not yet available.
From this package's source root, use Node.js 24 and run `npm ci` and
`make package`. In your Electron application, install the resulting tarball:

```sh
npm install /absolute/path/to/jelto-electron-1.0.0.tgz
```

See the [Electron Forge](https://jelto.io/docs/sdk/electron-forge) or
[Electron Vite](https://jelto.io/docs/sdk/electron-vite) integration guide for setup.

## Usage

```ts
import jelto from '@jelto/electron'

jelto.init('prd_xxxxxxxxxx', 'mac')
jelto.setProps({ license: 'paid' })
jelto.track('export_finished', { fmt: 'wav' })
jelto.onboarding('permissions', 'ok')
jelto.installId()
jelto.reset()
jelto.disable()
```

Call `init` once after your app decides telemetry may start. Before initialization,
other calls do nothing and the SDK creates no files or sockets. The optional
second argument is your registered app slug; when omitted, the OS is reported.

Each authorized initialization observes `app.getVersion()`. After the first known
version establishes a baseline, a different version automatically queues
`app_updated` with `from_version` and `to_version`, keeping the same install ID.
This includes downgrades and same-day changes. Versions are opaque strings;
missing, blank or overlong values leave the last known baseline unchanged.
Existing SDK state migrates without reporting an update. Offline transitions keep
their original IDs, timestamps and app metadata across retries and launches.
Reset drops queued updates for the previous identity and starts a new baseline;
disable wipes the baseline and queue with the rest of SDK state. Normal queue
limits and final server refusals still apply.

`setProps` persists install properties sent with heartbeats. `onboarding` wraps
`track('onboarding:<step>', { status })`. `reset` rotates the install ID;
`disable` wipes the ID and queue and makes later calls no-ops until another `init`.
Delivery and retries run in the background; failures are not thrown into your app.

Use the SDK in the main process and forward renderer events over IPC:

```ts
import { app } from 'electron'
import jelto from '@jelto/electron'

app.whenReady().then(() => {
  if (userAgreedToTelemetry()) {
    jelto.init('prd_xxxxxxxxxx', 'mac')
  }
})
```

## State and diagnostics

State lives in `app.getPath('userData')/jelto/`: install ID, heartbeat marker,
install properties, backoff, and queue. Electron is loaded lazily to resolve
this path, so the package also loads under plain Node. `JELTO_STATE_DIR` overrides
the entire directory for isolated tests.

Set `JELTO_DEBUG=1` to print every outgoing payload and rejection reason to stderr.
Without it, SDK stderr remains empty.

## Development and conformance

From the repository root:

```sh
npm ci
npm run build
npm run check
npm run test
npm run test:sdk
npm run test:host
make conformance
```

Tests use `node --test` with native TypeScript stripping, so source must use
erasable syntax. Bundles remain unminified for inspection.

The `host/` command adapter bundles to `dist/conformance-host.mjs`. Its wrapper
must `exec` Node so abrupt-exit tests kill the SDK process. State exports report
only facts the SDK holds, without supplying missing values.

Behavior is defined by the contracts
[wire specification](https://github.com/usejelto/contracts/blob/main/spec/wire-v1.md).
Certification requires two consecutive passing conformance runs on a clean machine,
with version, commit, and logs recorded as described in the contracts
[SDK conformance specification](https://github.com/usejelto/contracts/blob/main/spec/sdk-conformance.md) §6, and
repeated after minor wire additions. C11's memory budget remains unmet for Electron;
see the contracts [conformance notes](https://github.com/usejelto/contracts/blob/main/spec/conformance/TODO.md) §7.

Run development commands from this SDK directory. For shared conformance, set
`JELTO_CONTRACTS_DIR` to an extracted Jelto contracts **0.1.0** archive and run
`make conformance` twice. The archive contains the runner, mock server and schema;
the backend checkout is not needed. `make test` runs type, SDK and host checks,
and `make package` produces the npm tarball.

## Repository CI and releases

The component-owned workflows become active when this directory is the
repository root. CI runs local package tests; release CI additionally requires
conformance twice and the configured contracts pin where applicable.
See [RELEASING.md](https://github.com/usejelto/electron-sdk/blob/main/RELEASING.md) for initial publication, trusted publishing,
version tags, and retries. Publishing stays disabled until explicitly configured.

## Community and license

Questions, bug reports and documentation improvements are welcome. See
[Support](https://github.com/usejelto/electron-sdk/blob/main/SUPPORT.md),
[Contributing](https://github.com/usejelto/electron-sdk/blob/main/CONTRIBUTING.md),
[Code of Conduct](https://github.com/usejelto/electron-sdk/blob/main/CODE_OF_CONDUCT.md), and
[Security policy](https://github.com/usejelto/electron-sdk/blob/main/SECURITY.md).
Until the public repository is available, these files are also included in the
source root; contact [taha@jelto.io](mailto:taha@jelto.io) for help.

Jelto-owned software and associated documentation use the [MIT license](LICENSE).
Third-party materials retain their own terms, including the Contributor Covenant
attribution. Jelto names, logos, mascots and original brand artwork are excluded
from the software license; no trademark rights are granted.
