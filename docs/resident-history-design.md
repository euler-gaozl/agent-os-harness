# Resident history: measured gap and required core changes

2026-10-13. Status: design and repeatable baseline measurement; retention core
patch not yet implemented or deployed. The current engine remains
`dsh-source-639ed015-state-v1`, kernel SHA-256
`6f37d28cd08268fe29304b472a736efd0fe83fd5266d5b5902077395231fd121`.

## Evidence

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

The existing independent architecture reviewer read the code, benchmark, six
reports and matching script/artifact hashes. It found no blocker to committing
this measurement/design and required the reader boundaries above before any
eviction implementation. The reviewer did not run tests or inspect a working
retention patch; no such patch exists in this increment.
