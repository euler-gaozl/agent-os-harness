# Harness source ownership

This repository owns the platform's source-built DSH kernel and storage/context
plugins. Read README.md and upstream-lock.json before changes. The upstream
directory is a byte-preserved source baseline; do not silently edit its files or
update their baseline hashes. Put platform code in src and reviewed core diffs
in patches with an explicit build application step.

Runtime remains the authority for leases, effects, receipts and checkpoints.
No database credentials, provider keys, host execution tools, or writable local
session journal belong in the Node process. Keep the old Worker engines pinned;
new Harness code requires a new engine version and replay/fault acceptance before
deployment. A source build does not prove npm byte equivalence or bounded memory.

Use focused local tests and fixed dependencies. GitHub Actions remain disabled
under the workspace cost policy; do not create commit-triggered workflows. The
source v1 was activated on Windows on 2026-10-13; the integration repository's
source-engine-activation-20261013.md is the evidence authority. Later candidate
changes are not deployed by editing this repository or rebuilding dist. P2
retirement, bounded full history and cache cleanup remain open.
