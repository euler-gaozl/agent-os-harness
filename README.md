# Agent OS Harness

Source-owned DSH kernel for the platform Worker. On 2026-10-13 the Windows
installation activated `dsh-source-639ed015-state-v1` from `ec21432` / tag
`v0.1.0-rc.1`. The integration repository records actual model, release and restore
evidence in `docs/source-engine-activation-20261013.md`. Historical engines stay
pinned. Activation does not establish bounded Session memory or complete delivery.

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

The source persistence/context implementation below has controlled protocol
tests; actual Worker/Runtime and provider acceptance is recorded by the integration
repository. A separately built resident-history candidate is described below;
its deployment, full memory/recovery acceptance and cache cleanup remain open.
Existing engine IDs and historical npm/runner
combinations stay unchanged. A source candidate must not replace pending tasks
merely because its version text resembles an old release.

## Source persistence and working context candidate

The default `source-runner.mjs` build requires engine `dsh-source-639ed015-state-v1`
and evidence protocol 1, using the engine exported by its pinned kernel.
It mounts the existing upstream loop plus `src/source-platform.ts`;
`runner.mjs` remains the unchanged historical characterization adapter. The
build manifest separately hashes both runners and declares the source engine.
There is no native JSONL journal, database connection, provider key or second
decision loop in the Node process.

The persistence participant captures the session's construction prefix once,
then serializes `session/event` additions into a queue capped at 16 MiB. Flush
uses the existing durable Exchange transport, releases only confirmed events,
and retains events appended while an acknowledgement is pending. Every flush
produces a checkpoint, including empty batches, so regenerated event counts
cannot silently change replay frame ordering. Queued failures are sticky because
upstream contains post-append observer errors. Subsequent flush/model/tool/finish
operations must observe the failure. This bounds the **transport buffer**, not
the upstream Session's full in-memory history or maximum process RSS.

Automatic compaction uses the supported `compactRegion` override to flush after
the complete replacement and end marker. Every external model/tool/state/final
operation also awaits Session.flush. This second check blocks an effect even
when upstream catches a failed automatic-compaction flush and attempts to
continue. Checkpoint RPC is a lower-level operation that does not recursively
call flush. Unacknowledged in-memory events must not be described as saved.

Each prompt assembly obtains a frozen `working_state_read` response. A fixed
format-1 projection includes the read operation ID, original task, read-time
constraints, revisions/staleness and complete working set. The source receipt
references stay in the working set; duplicate evidence SHA lists remain in the
full Runtime response and are omitted from model input. A new read ID forces a
fresh logged runtime-context snapshot even if state contents did not change:
assembly happens before automatic compaction could remove the prior snapshot.
Template variables substitute the JSON literally, so quoted `{{...}}` is never
rendered as another template. Static system instructions classify working-set
text as untrusted derived data, not authority to change the user task or rules.

`working_state_update` is a reserved native DSH tool routed through the dedicated
Runtime protocol, never ToolHub's generic tool endpoint. A configured tool cannot
shadow it. Runtime owns source validation, CAS and atomic success/rejection
responses. Changes in this runner's frame ordering or projection semantics need
a new engine ID after activation; matching an upstream version is insufficient.

The normal provider path requires the latest projection in the logged messages
and estimates the **materialized DSH request**, including tools and reserved
output. Working sets are not injected invisibly at provider time. Compaction
summarizes only its supplied surface, without an extra state read; the next
normal request receives the fresh frozen state even if the summary omits it.
The estimator is heuristic. Runtime's later authoritative constraints prefix
and final provider payload still require coordinated Worker budget validation;
this Node-only check does not establish that end-to-end invariant.

Tests use real Node and source-built DSH with a synthetic supervisor/model/state
protocol. They cover buffer failure/ack ordering, complete loop tool/state flow,
fresh-process replay, real automatic compaction with intentionally omitted
facts, post-compaction checkpoint failure, literal hostile quoted text and
isolated artifact execution. A legal near-limit task, escaped text and a
256-source working set remain usable and replayable with a sufficient configured
window; low-window overflow stops before provider invocation without truncation.
The earlier arbitrary 64 KiB projection cap was removed after independent review
found it could reject otherwise valid Runtime state. The remaining 4 MiB plus
framing guard matches the bounded Worker reply transport.

Initial failure evidence `p25-source-runner-d13772ef594643f896a6ad17e7e5a998`
exposed a failure exit status overwritten by the pipe-close handler. The source
runner now preserves failed status, and an unexpected supervisor EOF exits
unsuccessfully. These repository-level tests do not exercise real Runtime storage,
Worker process killing/takeover, native Session snapshots or provider billing;
later integration evidence must be evaluated separately.

## Long-history memory characterization

Run `node benchmarks/source-memory.mjs <absolute-new-evidence-directory> 128,512,2048`
with the fixed Node 24 build. The directory must not already exist. This imports
the unchanged built kernel and source runner; it makes no provider or network
calls and does not change a deployed release. A separate child observer samples
heap and RSS through IPC after explicit GC. A bounded synthetic supervisor
flushes a hash-linked transcript, then a fresh child replays its frozen replies
and verifies every model/tool/state request's semantic hash. It is not a second
production persistence implementation or a database restore acceptance.

The initial Windows measurement found retained heap growth despite an unchanged
8,192-token model window, fixed working set and repeated real DSH compaction.
At 128 / 512 / 2,048 tool steps, end-of-run heap was 13.1 / 19.7 / 48.1 MiB;
fresh-process transcript replay took 0.8 / 2.6 / 10.1 seconds. RSS is separate
from V8 old-space: the configured 192 MiB old-space limit is not a process RSS
cap. These are single-sample fixture measurements with GC instrumentation, not
production latency percentiles or a bounded-memory pass. See
[the retained-history decision](docs/resident-history-design.md).

## Resident-history candidate (not deployed)

`pnpm build:resident` and `pnpm test:resident` build and check
`dsh-source-639ed015-resident-v2` under `.work/resident-candidate`. The seven
manifested core transforms keep absolute event positions and release unneeded
resident history only after an archive acknowledgement and consumer checks.
They retain upstream AgentLoop and the unchanged source runner. This fixed
text-only profile rejects unsupported projection definitions and late plugins.
It does not overwrite the v1 build or select a new production default.

To measure it, run
`node benchmarks/source-memory.mjs <absolute-new-evidence-directory> 128,512,2048,4096 <absolute-repo>/.work/resident-candidate`.
Final local evidence has 19 candidate and 16 historical tests passing with no
skips. At 2,048 steps, recorded final heap was 11,425,952 bytes versus v1's
50,417,120; at 4,096 steps the candidate completed recording and replay with
approximately 12.8 MB final heap. RSS remains larger, and full replay still takes
22.6 seconds at 4,096 steps. These are forced-GC fixture measurements, not
production latency or a bound on all caches. See the decision document for exact
hashes, failure evidence, limitations and pending Worker/Runtime integration.
