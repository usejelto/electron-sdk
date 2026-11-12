# Contributing to @jelto/electron

Bug reports, documentation corrections, examples and focused code changes are
welcome. Participants follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Start a contribution

Search [existing issues](https://github.com/usejelto/electron-sdk/issues) before opening one. Use a bug report for
reproducible failures, a feature request to explain a use case, or a blank issue
for questions and documentation feedback. Discuss substantial features and
breaking changes before implementing them. Small fixes can go straight to a PR.

Send security reports privately as described in [SECURITY.md](SECURITY.md).
For installation and account help, see [SUPPORT.md](SUPPORT.md).

## Local development

Node.js 24.22.2 (the release `.nvmrc` pins), npm, Make, Python 3.11 or later, and the Go toolchain required by the contracts archive. Node.js 24 is needed for source tests; the distributed SDK supports Node.js 22 or later, and CI runs the tests on the oldest Node 22 release as well.

Fork and clone this repository, create a branch from `main`, and run commands
from this component's root. The standalone checkout contains its build inputs;
you do not need the private Jelto backend.

Shared conformance needs a verified Jelto contracts **0.1.9** archive. Download
it and its checksum from the [contracts releases](https://github.com/usejelto/contracts/releases)
when published, then install it into an empty directory:

```sh
python3 vendor/test-tools/install.py /absolute/path/jelto-contracts-0.1.9.zip SHA256 /absolute/path/contracts --version 0.1.9
export JELTO_CONTRACTS_DIR=/absolute/path/contracts
```

Replace `SHA256` with the checksum from that release. Use the Go version in the
archive's `go.mod`. Before the first public release, obtain the reviewed archive
from the maintainer. Monorepo contributors may explicitly point
`JELTO_CONTRACTS_DIR` at the local contracts root. Builds must not discover a
sibling checkout implicitly.

```sh
npm ci
make test
make conformance-twice
make package
```

Run the smallest relevant checks while iterating, then the affected gates above.
Documentation-only changes need link and example review; SDK behavior or wire
changes require the appropriate tests and two consecutive conformance passes
before certification. Package changes must also pass packaging checks.

Keep SDK regression tests beside source in `src/`, and testing-protocol cases
in `host/`. Use the contracts wire and conformance specifications as the public
behavior references. Run the shared harness twice before certification; attach
version, commit and results. Electron's C11 memory-budget limitation remains
recorded in the contracts `spec/conformance/TODO.md`; passing the shared harness
alone does not resolve it.

## Checks and exceptions

`make check` is the whole gate, and the command CI runs on Linux. It runs `lint`, `deadcode`, `boundaries`, `test`, `build`, `package`, `security` and `format-check`. `make hooks`
enables two Git hooks once per clone: `commit-msg` rejects a subject that is
not a Conventional Commit, and `pre-commit` runs gitleaks over the staged
changes. Do not bypass them with `--no-verify`.

The security targets run separate programs, not project dependencies.
`vendor/quality/tools.json` pins each one's exact version and SHA-256; the first run
downloads and verifies it into `~/.cache/jelto-tools` (`JELTO_TOOLS_DIR`
overrides the location), and `make tools` installs them all ahead of time.
`vendor/quality/` is a checksummed snapshot of the contracts repository's
`tools/quality/`; change it there, not here. ESLint, Knip,
dependency-cruiser and Prettier are development dependencies, pinned by
`package-lock.json`.

| Target | Tool | What it checks |
|---|---|---|
| `make lint` | ESLint | the recommended JavaScript and TypeScript rules (`eslint.config.js`), no warnings |
| `make deadcode` | Knip | files nothing imports, unused exports and dependencies, undeclared ones (`knip.config.ts`) |
| `make boundaries` | dependency-cruiser | no cycles, no unresolved import, shipped code uses only `dependencies`, and `src/` never imports `host/`, `scripts/` or `build.mjs` (`.dependency-cruiser.cjs`) |
| `make format-check` | Prettier | formatting (`.prettierrc.json`); `npx prettier --write .` applies it. Markdown, vendored and generated files and the lockfile are left alone (`.prettierignore`) |
| `make secrets` | gitleaks | the whole Git history for credentials |
| `make workflow-audit` | actionlint, zizmor | workflow syntax, script injection, permissions and pinning |
| `make osv` | OSV-Scanner | `package-lock.json` against the OSV database, downloaded and matched locally |
| `make npm-audit` | npm audit | `package-lock.json` against the npm advisory database |
| `make sast` | opengrep | the community TypeScript, JavaScript and Unicode rules, and the repository's own rules in `.opengrep/` (no client-address header is read; contracts come from `JELTO_CONTRACTS_DIR`), each tested against its test file |

When a check reports something, fix a real problem in the same change. A
deliberate exception, or a finding the tool got wrong, is marked at the one
place it applies, with the reason beside it:

- gitleaks: a `.gitleaks.toml` allowlist entry naming the one literal and why;
- zizmor: `# zizmor: ignore[<audit>]` on the line, with the reason above it;
- OSV-Scanner: an `[[IgnoredVulns]]` entry in `osv-scanner.toml` with a
  `reason` and an `ignoreUntil` date;
- ESLint: `// eslint-disable-next-line <rule> -- <reason>` above the line;
- Knip: an entry in `knip.config.ts` for a file or dependency a tool loads
  without an import, with the reason in a comment;
- dependency-cruiser: a `pathNot` on the one rule and path it concerns, with
  the reason in the rule's comment;
- opengrep: `// nosemgrep: <rule-id> -- <reason>` at the end of the finding's
  first line;
- Prettier: `// prettier-ignore` on its own line above the one statement,
  with the reason in a comment above it.

Knip started with a baseline of the findings that predate it,
`.knip-baseline.json`; its 30 exports used only inside their own module are
no longer exported, and the baseline is empty. A fixed finding fails until it
leaves the baseline (`make knip-baseline`, then review the diff). Nothing is
added to a baseline to make a check pass.

Never disable a rule, a file or a directory wholesale, and never relax a
threshold to make a check pass.

## Review and acceptance

Keep changes focused and match the surrounding style.
TypeScript uses strict types and two-space indentation. Source tests require erasable TypeScript syntax.
Add regression coverage for behavior changes. Do not update expected values just to match a
failing implementation, and do not edit generated or vendored inputs by hand.

Use a scoped Conventional Commit title, such as `fix(electron): clarify retry handling` or `docs(electron): explain local installation`. Describe the problem,
the resulting behavior, relevant issue/specification, compatibility impact and
exact verification commands with results. Include screenshots for visible UI
changes. State when a check was not run and why. A separate specification change
should precede its implementation; fixture expectation changes need a separate
commit explaining their derivation.

Use synthetic data in examples and reports. Never include credentials, customer
payloads or IP addresses in public logs. Contributions must preserve Jelto's
privacy boundaries: no IP storage or logging, and no row-level identifier that
joins a website visitor to an app install.

Taha Bozdemir reviews scope, correctness, tests and compatibility, and decides
whether to merge. Review is best effort with no guaranteed turnaround. Maintainers
may request changes or decline work outside the component's purpose; explain
tradeoffs in the issue or PR so future contributors can follow the decision.

## Licensing and releases

Submit only work you have the right to contribute, under this repository's
[MIT license](LICENSE). Preserve third-party notices and the Contributor Covenant
attribution. Jelto names, logos, mascots and original brand artwork are excluded
from the software license; no trademark rights are granted. No separate CLA or
DCO sign-off is required.

Maintainers publish releases using [RELEASING.md](RELEASING.md). Local packaging
does not publish, and a successful test run is not a release announcement.
