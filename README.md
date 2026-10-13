# Agent OS Harness

Source-owned DSH kernel candidate for the platform Worker. This repository is
preparation for the storage/context phase; no deployed Worker selects it yet.

The upstream tag `dsh-v0.2.0-rc.2` resolves to
`639ed015397290b3745d163aafe02ffee4aa3f84`. `upstream-lock.json` records the
official archive hash and every imported file. Twenty-one complete source
package directories cover the kernel dependency graph; the official CLI,
desktop app, Web, Python SDK and unrelated services are not imported. Upstream
code and MIT notices remain unchanged under `upstream/`. This establishes a
source baseline, not byte equivalence to the published npm artifacts.

Install fixed build dependencies with `pnpm install --frozen-lockfile --ignore-scripts`.
Use Node 24, then `pnpm build` and `pnpm test`. The build verifies all upstream
file hashes, compiles the actual TypeScript source and rejects imports outside
this checkout or external runtime dependencies other than Node built-ins.
`dist/manifest.json` binds the source/dependency locks, build tool, input hashes
and output digest. Dependencies are esbuild and Zod, not prebuilt DSH npm packages.
The existing Worker runner's bridge and the Session interface checks are retained
as baseline characterization; source compilation alone is not type checking of
the complete upstream monorepo or comprehensive behavioral compatibility.

One packaging transform in `patches/inline-package-version.mjs` replaces the
LLM attribution module's runtime `../package.json` read with the version from
its locked source manifest. Its original/transformed bytes, metadata and transform
script are hashed in the build manifest. Upstream files remain untouched. This
avoids both reading the platform package's unrelated version and a missing-file
failure when only runtime artifacts are deployed. Tests exercise that relocated
artifact outside the checkout, with its own working directory, no package
manifests or node_modules in its lookup ancestors, and global module search
disabled. Set `HARNESS_TEST_ARTIFACT_ROOT` to an external scratch directory if
the OS temporary directory has dependency-bearing ancestors. The build's import
list alone cannot detect every runtime file lookup; it is not a confinement proof.

The resulting kernel exports Cordis, Session, AgentLoop, tools, model interfaces,
projection and compaction. `runner.mjs` explicitly mounts the platform subset.
Node receives no provider key or database login. The Go Worker remains responsible
for recorded model/tool transport, leases and receipts; Runtime is the durable
authority. Importing a source package does not mount its capabilities.

Persistence/checkpoint plugins, structured working state, bounded history,
cache cleanup and new engine integration are still to be implemented and
validated. Existing engine IDs and historical npm/runner combinations stay
unchanged. A source candidate must not replace pending tasks merely because
its version text resembles an old release.
