# Resident history: measured gap and required core changes

2026-10-13. Status: resident-v2 core candidate implemented and locally measured;
Worker/Runtime integration, process-fault acceptance and deployment remain open.
The deployed engine remains
`dsh-source-639ed015-state-v1`, kernel SHA-256
`6f37d28cd08268fe29304b472a736efd0fe83fd5266d5b5902077395231fd121`.

## Baseline evidence

Raw local evidence is under
`D:\workspace\agent-platform\local\evidence\dsh-memory-baseline-0e3b3a7a0b56427b94e138b75dae77f4`.
The earlier 16-step smoke run is `dsh-memory-smoke-f5f71460cc9c454fb71c279fb8d6d2a6`.
The scripts and their hashes are recorded by `result.json`. This is a real
source-built DSH loop with synthetic model, tool and state replies. No paid
provider, Runtime, Worker, PostgreSQL or production artifact service participates.

| Tool steps | Original event bytes | Real compactions | Retained heap at finish | Fresh process replay | Maximum model JSON bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | 1,559,677 | 127 | 13,718,896 | 805 ms | 9,795 |
| 512 | 6,242,941 | 511 | 20,609,896 | 2,590 ms | 9,795 |
| 2,048 | 25,025,207 | 2,047 | 50,417,120 | 10,132 ms | 9,795 |

All six recording/replay children exited successfully. At 2,048 steps, 22,535
events were archived in a 40,517,085-byte test transcript (including replies and
record envelopes). Recording took 16,140 ms including a synchronous flush before
each reply. Replay validated the chained records, exact frame order, every
semantic request hash and event batch counts/types. Reconstructed event identity
and timestamps are not claimed to equal original event bytes; originals stay in
the recording. The deliberately incomplete summaries omit the date and quantity;
the fixed working state remains in every normal model request.

Samples are taken in the child after forced GC at model boundaries and finish,
including the live request/serialized frame. The supervisor streams one record
at a time and does not retain the transcript in the measured child. Initial heap
was approximately 9.58 MB for each child. At 2,048 steps final RSS was
216,711,168 bytes when recording and 221,720,576 bytes when replaying. V8's
192 MiB old-space flag does not cap RSS. The single samples include instrumentation
and cannot establish production latency, RSS limits or a memory plateau. The
constant request size plus growing retained heap confirms the issue independently
of model-window size; it does not attribute every retained byte to one field.

## Why the existing extension points are insufficient

`SourcePersistence` frees confirmed transport batches, but `Session.log` remains
a full in-memory event array. `deriveMessages` and surface replacement remove
messages from current model input without deleting original events. A flush
listener cannot safely splice the log: `seq`, appends, SurfaceManager and other
consumers use absolute sequence numbers as array positions.

The minimal change crosses several readers, not the model decision loop:

| Reader/state | Required boundary before eviction |
| --- | --- |
| Session and SurfaceManager | Separate monotone absolute event sequence from resident storage; keep current surface nodes and projected messages, and consume any pending surface plan |
| Header/context folds | Consume new events before release; retain current folded state and required historical header definitions |
| ToolHistoryProjection | Bound old header/definition/update retention by active declaration series and live references; cannot discard a header still named by an addition |
| TokenMeter | Advance its event cursor before release; a first read must not silently restart at zero after history has left memory |
| Session projection registry | Materialize every mounted projection before release; reject or explicitly rebuild late registration instead of returning an incomplete state |
| RuntimeContextProjection | Preserve the distinction between context never having existed and context having been compacted away; forbid late construction after eviction or restore its folded state |
| Compact entry inspection | Replace the backwards full-log scan with folded open-turn/unmatched-compaction/last-seed state; absence of a seed marker is itself known state |
| Snapshot/fork/invariant consumers | Full-history reads must remain explicit and truthful; a resident-only subset must never masquerade as complete `snapshotEvents()` |

Archive sequence is not enough on its own. Release requires a confirmed durable
archive watermark, all mounted consumers synchronized, no live surface/reference
dependence and no pending append publication. A failed/unknown acknowledgement
must preserve pending data and block subsequent effects. The Runtime ledger and
archive stay authoritative; the Node process gets no writable journal or database
credentials. Deleting resident history is not permission to delete its archive.

The independent review also identified secondary references: SurfaceManager's
`projectedMessages` can retain replaced nodes, and ToolHistoryProjection retains
old headers. The current runner does not mount a plugin producing the former
message projections, so this is a future retention requirement, not a proven
source of the measured growth. A candidate must freeze its plugin/consumer set
or reject unsafe late construction, unloading and re-registration. Release uses
the captured acknowledged `start + count`, never the newer Session sequence after
an awaited response; events appended while waiting remain unconfirmed. Start
with explicit checkpoint acknowledgements. GC timing and RSS must not change
the replay-visible checkpoint schedule.

## Candidate contract and implementation order

1. Add a separately built candidate with a new engine identity. Preserve v1
   source/artifacts and replay semantics; do not overwrite pending-task engines.
2. Introduce absolute-sequence resident storage and folded control state. Keep
   current surface, required headers, pending tool/turn/compaction state and the
   unconfirmed suffix. Bound bytes and entries; fail before an external effect
   when the irreducible working set itself exceeds the configured budget.
3. At acknowledged barriers, synchronize consumers and release only unneeded
   confirmed events. Unsupported full-history or late-plugin operations must
   fail explicitly or use the authoritative archive path, not synthetic events.
4. Initially retain the existing deterministic Exchange replay. Measure its
   history-dependent cost honestly. A native resumable Session checkpoint is a
   separate versioned protocol: it must bind archive prefix, engine/build and
   consumer projection states, and must never become another effect authority.
5. Validate increasing histories at fixed working set, evidence reread after
   compaction, commit-before-ack failures, actual Worker takeover, cancellation,
   changed constraints, old-engine compatibility and candidate relocation.
   Only then select a new default and test actual release rollback guards.

This changes DSH storage/projections while leaving its AgentLoop, tool dispatch
and compaction decisions in charge. The first accepted patch should include
the retained data structures and the consumer handoff together; a log splice,
larger heap limit, or lower model window does not satisfy this contract.

At the baseline/design stage, the independent architecture reviewer read the code, benchmark, six
reports and matching script/artifact hashes. It found no blocker to committing
this measurement/design and required the reader boundaries above before any
eviction implementation. The reviewer did not run tests or inspect a working
retention patch at that stage. The candidate implementation below is a later increment.

## Implemented resident-v2 candidate

`pnpm build:resident` creates `.work/resident-candidate` without overwriting v1's
`dist`. The engine is `dsh-source-639ed015-resident-v2`. The existing source
runner is copied unchanged; its imported kernel exports the new engine identity.
Seven explicit build transforms modify Session, SurfaceManager, tool history,
compact boundary inspection, TokenMeter, SessionProjection and RuntimeContext.
The manifest binds original/transformed bytes and the transform script. All 342
locked upstream files remain unchanged. AgentLoop and compaction decisions stay
upstream-owned; source bundling is not a full upstream TypeScript type check.

`ResidentEventLog` separates monotone absolute sequence numbers from a sparse
Map of resident events. It limits serialized UTF-8 event content to 16 MiB and
8,192 entries. The persistence queue retains its separate 16 MiB limit. Current
surface nodes, latest/needed tool headers and unconfirmed suffix events remain
resident. Open-turn, unmatched-compaction and last-seed facts are incrementally
folded instead of found by scanning the entire archive. Reads of evicted history
fail explicitly; they never return a resident subset as complete history.

After a valid checkpoint reply, the persistence adapter checks for failures
that occurred while awaiting the reply, checks the actual consumer instance
identities, advances every allowed projection and TokenMeter, then releases
only the acknowledged batch's captured end. Events appended during that await
remain unconfirmed. Full-history snapshots already returned to callers remain
immutable. Failed/unknown replies, consumer unloading and buffer failure block
later effects. There is no second durable writer or automatic archive deletion.

This candidate supports the five actual built-in projection definitions used by
the fixed runner: token usage, context pressure, context breakdown, turn boundary
and inbox. Registration checks object identity, including before the first
checkpoint; a matching name/version is insufficient. Late registration and
custom message projections are rejected. TokenMeter and combined projection
states each have an 8 MiB serialized UTF-8 guard. Tool-history series retains its
update semantics, with an 8,192-update / 8 MiB guard, while unneeded old header
maps are pruned. These guards do not bound every possible cache or process RSS.
An oversized irreducible state stops instead of silently truncating information.

## Candidate validation and limits

Final evidence:
`D:\workspace\agent-platform\local\evidence\dsh-resident-candidate-a3dbb9f031714241a2b3e0dc8d734b3b`.
`verification.json` binds implementation/test/benchmark hashes;
`candidate-manifest.json` and `result.json` bind kernel SHA-256
`be1b87c92a7b9b1dae332a10115ef04ddd676a2aa82e90d02c2943e296c9932c`.
The measured working tree was based on `f4c005e`; that parent commit alone is
not the identity of the tested candidate. Runner SHA-256 remains
`321db6d2b571f65ee22e802da2aa159ba045618a1f17328fd63f28a1e2fa18e3`.

| Tool steps | Event bytes | Real compactions | Final heap, record / replay | Full replay time |
| ---: | ---: | ---: | ---: | ---: |
| 128 | 1,559,677 | 127 | 11,448,800 / 11,448,336 | 934 ms |
| 512 | 6,242,941 | 511 | 12,125,456 / 10,979,856 | 3,106 ms |
| 2,048 | 25,025,207 | 2,047 | 11,425,952 / 12,629,760 | 11,593 ms |
| 4,096 | 50,094,775 | 4,095 | 12,774,672 / 12,797,720 | 22,643 ms |

All eight child processes completed with exit 0. At 4,096 steps, the recording
contains 45,063 events and 36,867 frames in an 81,094,109-byte transcript; it took
34,323 ms to record. Final record/replay RSS was 172,601,344 / 173,088,768 bytes,
much larger than retained heap. The fixed-window, fixed-state, forced-GC fixture
shows reduced retained heap; it is not a general memory plateau or RSS cap proof.
No provider, Runtime, Worker, database or deployed service participated.

`pnpm test:resident` passed 19 tests with zero skips: 12 focused retention/failure
checks and seven complete source-runner checks. The old default suite passed all
16 tests with its unchanged v1 kernel. The focused checks include a late suffix
while awaiting confirmation, malformed/lost replies, overflow during that await,
early and late unsupported registrations, consumer unloading, tool-header
addition/removal/series continuity, distant surface pins and folded boundaries.
The runner checks include automatic compaction, preserved working state,
fresh-process replay, budget rejection and relocated runtime artifacts.

The old and new 128/512/2,048 fixture transcripts also match every semantic
request hash, frame ordering, event sequence/type and non-checkpoint reply
(1,155 / 4,611 / 18,435 frames). Checkpoint archive hashes legitimately differ
because original event IDs/timestamps differ. This fixture comparison does not
authorize running an old task with a different engine. No old 4,096-step
baseline was recorded, so no cross-engine claim is made for that size.

The initial smoke candidate failed its first checkpoint because Cordis returns
context-bound wrappers rather than stable service-object identities. Evidence
`dsh-resident-smoke-f9809cbf38914a6f8367bf9102735e5b` is retained. Instance-owned
Symbols fixed that check. An early unit-test fixture incorrectly wrapped a
flat user message; the fixture was corrected. Independent static review then
found that unknown pre-registered projections could bypass a meaningful JSON
state-size check. The five-definition identity allowlist closed that gap, with
negative tests. Earlier successful memory runs used different candidate hashes;
only the final evidence above applies to this implementation.

The independent architecture reviewer checked all 12 verification-file hashes,
manifest inputs and both kernel identities, both TAP files, all eight child
reports and the three comparison reports. It found no blocking issue for
committing this undeployed candidate. This was a read-only static/evidence
review; the reviewer did not execute tests, providers or CI.

Restore still replays the entire frozen exchange prefix: the 4,096-step replay
cost is real and has not been reduced by this patch. Native checkpoint resume,
cache lifecycle, actual Worker takeover/cancellation/unknown-effect tests and
v2-aware version selection remain separate work. The production tag, release
lock, deployment and retained v1 tasks are unchanged. This increment ran no
GitHub Actions and made no paid model calls.
