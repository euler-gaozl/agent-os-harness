import fs from 'node:fs';
import path from 'node:path';

// Explicit candidate transform. Every match is checked; upstream bytes and the
// v1 build remain untouched. Original/transformed and transform hashes are sealed.
export function residentHistory(root,sha256) {
  const changed=new Map(), records=[];
  const transformHash=sha256(fs.readFileSync(new URL(import.meta.url)));
  function edit(file,change) {
    const original=fs.readFileSync(path.join(root,file),'utf8');
    let text=original;
    const replace=(before,after)=>{
      if(text.split(before).length!==2) throw new Error(`resident patch mismatch: ${file}: ${before.slice(0,70)}`);
      text=text.replace(before,after);
    };
    const all=(before,after)=>{
      if(!text.includes(before))throw new Error(`resident patch missing: ${file}: ${before}`);
      text=text.split(before).join(after);
    };
    change(replace,all,()=>text);
    changed.set(path.resolve(root,file),text);
    records.push({id:'resident-history-v2',target:file,transform_sha256:transformHash,
      original_sha256:sha256(original),transformed_sha256:sha256(text)});
  }
  edit('upstream/packages/core/session/src/index.ts',(replace)=>{
    replace('export class Session {', `import { ResidentEventLog } from '@agent-os/resident-log'

export class Session {`);
    replace('private log: SessionEvent[] = []','private log = new ResidentEventLog<SessionEvent>()');
    replace('this.log[inheritedEventCount]','this.log.get(inheritedEventCount)');
    replace('return this.log[seq]','return this.log.get(seq)');
    replace('this.deriveEventMessage(this.log[seq]!)','this.deriveEventMessage(this.log.get(seq)!)');
    replace('  /** Cached immutable full snapshot of the private append-only log. */',`  residentStats() { return this.log.stats() }
  compactionEntryState() { return this.log.compactionEntryState() }

  // Called only by the fixed candidate after synchronizing all mounted consumers.
  releaseArchived(through: number): void {
    if (attachments.get(this)?.appending) throw new Error('cannot evict during append publication')
    this.log.assertHealthy()
    this.surfaceManager.assertResidentCompatible()
    this.requestHeader()
    this.requestContext()
    this.toolHistory()
    const keep = new Set<number>(this.surface.nodes)
    if (this.log.latestHeader !== undefined) keep.add(this.log.latestHeader)
    // Unconfirmed events remain resident; preserve the headers their additions cite.
    for (const event of this.log.residentEvents()) {
      if ((keep.has(event.seq) || event.seq >= through) && event.type === 'developer/message'
        && event.data.headerSeq !== undefined) keep.add(event.data.headerSeq)
    }
    this.toolHistoryProjection.releaseHeaders(keep)
    this.deriveMessages() // Drop any old derived-message cache after replacements.
    this.eventsSnapshot = undefined
    this.log.release(through, keep)
  }

  /** Cached immutable full snapshot of the private append-only log. */`);
  });
  edit('upstream/packages/core/session/src/surface.ts',(replace,all)=>{
    replace("import type { Message, ToolSchema }",`import type { ResidentEventLog } from '@agent-os/resident-log'
type EventReader = readonly SessionEvent[] | ResidentEventLog<SessionEvent>
function readEvent(events: EventReader, index: number): SessionEvent | undefined {
  return Array.isArray(events) ? events[index] : (events as ResidentEventLog<SessionEvent>).get(index)
}

import type { Message, ToolSchema }`);
    // Public message-projection context stays a real complete array. This fixed
    // text-only runner mounts no message-projection plugins; reject that profile.
    all('events: readonly SessionEvent[],','events: EventReader,');
    replace('private log: readonly SessionEvent[],','private log: EventReader,');
    replace('events[headerSeq - baseSeq]','readEvent(events, headerSeq - baseSeq)');
    replace('events[originalSeq - baseSeq]','readEvent(events, originalSeq - baseSeq)');
    replace('events[state.nodes[0] as number - baseSeq]','readEvent(events, state.nodes[0] as number - baseSeq)');
    replace('this.log[index]!','readEvent(this.log, index)!');
    replace('this.log[candidate.expectedSeq - this.baseSeq]','readEvent(this.log, candidate.expectedSeq - this.baseSeq)');
    replace('  if (projection !== undefined) {',`  if (projection !== undefined) {
    if (!Array.isArray(events)) throw new Error('message projection plugins are outside the resident candidate profile')`);
    replace('    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)',`    for (const seq of plan.shadowedSeqs) state.projectedMessages.delete(seq)
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)`);
    replace('  /** Monotonic count of folded positional replacements. */',`  assertResidentCompatible(): void {
    if (this.projections.length !== 0) throw new Error('resident candidate requires a fixed text-only message projection profile')
    this._processDelta()
  }

  /** Monotonic count of folded positional replacements. */`);
  });
  edit('upstream/packages/core/session/src/tool-history.ts',(replace)=>{
    replace('  /**\n   * Read an immutable snapshot;',`  releaseHeaders(keep: ReadonlySet<number>): void {
    // Preserve update semantics exactly, including the auxiliary-prefix fallback.
    // A declaration series resets updates naturally; an oversized irreducible
    // series is rejected rather than silently rewriting its meaning.
    if (this.history.updates.length > 8192 || Buffer.byteLength(JSON.stringify(this.history)) > (8 << 20))
      throw new Error('resident tool history budget exceeded')
    for (const seq of this.headers.keys()) if (!keep.has(seq)) this.headers.delete(seq)
  }

  /**\n   * Read an immutable snapshot;`);
  });
  edit('upstream/packages/compaction/compaction-basic/src/region.ts',(replace,all,current)=>{
    const from='function inspectCompactionEntryState(session: Session): CompactionEntryState {';
    const before=current().slice(current().indexOf(from)).trimEnd();
    if(!before.endsWith('}'))throw new Error('unexpected compaction source tail');
    replace(before,`${from}
  return session.compactionEntryState() as CompactionEntryState
}`);
  });
  edit('upstream/packages/llm/token-meter/src/index.ts',(replace)=>{
    replace('  private readonly states = new WeakMap<Session, ReplayState>()',`  readonly retentionIdentity = Symbol('resident token meter')
  private readonly states = new WeakMap<Session, ReplayState>()`);
    replace('  /** Resolve the routed model\'s image pricing,',`  prepareRetention(session: Session): void {
    const state = this._sync(session)
    if (state.consumedEvents !== session.seq || Buffer.byteLength(JSON.stringify(state)) > (8 << 20))
      throw new Error('resident token meter state not synchronized or exceeds budget')
  }

  /** Resolve the routed model's image pricing,`);
  });
  edit('upstream/packages/session/session-projection/src/index.ts',(replace)=>{
    replace("import { Context, Service } from '@deepseek-ai/cordis'", `import { isResidentProjection } from '@agent-os/resident-profile'
import { Context, Service } from '@deepseek-ai/cordis'`);
    replace('  private readonly registrations = new Map<string, Registration>()',`  readonly retentionIdentity = Symbol('resident projection registry')
  private readonly registrations = new Map<string, Registration>()
  private retentionRegistrations: readonly Registration[] | undefined

  prepareRetention(session: Session): void {
    const current = [...this.registrations.values()]
    if (this.retentionRegistrations !== undefined && (current.length !== this.retentionRegistrations.length
      || current.some((row, index) => row !== this.retentionRegistrations![index])))
      throw new Error('resident projection registration changed')
    this.materializeCells(session)
    let bytes = 0
    for (const row of current) {
      const cell = row.cells.get(session)!
      if (cell.observedSeq !== session.seq - 1) throw new Error('resident projection has an unsynchronized cursor')
      bytes += Buffer.byteLength(JSON.stringify(cell.state))
    }
    if (bytes > (8 << 20)) throw new Error('resident projection state budget exceeded')
    this.retentionRegistrations ??= current
  }`);
    replace('    const wire = definition.wire as {',`    if (this.retentionRegistrations !== undefined) throw new Error('late projection registration is disabled after resident retention starts')
    if (!isResidentProjection(definition)) throw new Error('unsupported resident projection definition')
    const wire = definition.wire as {`);
  });
  edit('upstream/packages/core/agent-loop/src/runtime-context.ts',(replace)=>{
    replace('    const surface = new Set(session.surface.nodes)',`    if (session.residentStats().evicted > 0) throw new Error('runtime context projection cannot be constructed from evicted history')
    const surface = new Set(session.surface.nodes)`);
  });
  return {records,plugin:{name:'candidate-resident-history',setup(build){
    build.onResolve({filter:/^@agent-os\/resident-log$/},()=>({path:path.join(root,'src/resident-log.ts')}));
    build.onResolve({filter:/^@agent-os\/resident-profile$/},()=>({path:path.join(root,'src/resident-profile.ts')}));
    build.onLoad({filter:/\.ts$/},args=>{
      const contents=changed.get(path.resolve(args.path));
      return contents===undefined ? undefined : {contents,loader:'ts',resolveDir:path.dirname(args.path)};
    });
  }}};
}
