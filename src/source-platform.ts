import type {Context} from '@deepseek-ai/cordis';
import type {Session, SessionEvent} from '@deepseek-ai/dsh-session';

export const SOURCE_ENGINE = 'dsh-source-687f282e-state-v1';
export const WORKING_CONTEXT_MARKER = 'AGENTOS_WORKING_STATE_V1\n';
const MAX_BATCH_BYTES = 16 << 20;

type Frame = {method: string; params: unknown; events: unknown[]; event_start: number; event_end: number};
type Exchange = (frame: Frame) => Promise<unknown>;

// This buffer is a transport participant, never a second durable authority.
// Session still owns its full log; bounding this queue does not bound that log.
export class SourcePersistence {
  private queue: string[] = [];
  private bytes = 2;
  private observed = 0;
  private acknowledged = 0;
  private failed: Error | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private session: Session | undefined;
  lastAnswer: any;
  lastTurnEnd: any;

  constructor(ctx: Context, private runID: string, private exchange: Exchange, private limit = MAX_BATCH_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 128 || limit > MAX_BATCH_BYTES) throw new Error('invalid event buffer budget');
    ctx.on('session/created', session => {
      if (this.session || session.id !== runID) throw new Error('source runner accepts one fresh owned session');
      this.session = session;
      // Capture only the construction prefix, once. Normal barriers never
      // materialize snapshotEvents() or reserialize all prior history.
      for (const event of session.snapshotEvents()) this.observe(event);
      this.assertHealthy();
    });
    ctx.on('session/event', (session, event) => {
      if (session !== this.session) { this.latch(new Error('unexpected source session')); return; }
      this.observe(event);
    });
    ctx.on('session/flush', async session => {
      if (session !== this.session) throw this.latch(new Error('flush for unowned source session'));
      // Always emit a checkpoint, including an empty batch: frame ordering
      // must not depend on event counts regenerated during replay.
      await this.request('checkpoint', {});
    });
  }

  private latch(error: unknown): Error {
    this.failed ??= error instanceof Error ? error : new Error('source persistence failed');
    return this.failed;
  }
  assertHealthy(): void { if (this.failed) throw this.failed; }

  private observe(event: SessionEvent): void {
    if (this.failed) return;
    try {
      if (event.seq !== this.observed) throw new Error('source event sequence gap');
      const raw = JSON.stringify(event);
      const size = Buffer.byteLength(raw) + (this.queue.length ? 1 : 0);
      if (this.bytes + size > this.limit) throw new Error('source event buffer budget exceeded');
      this.queue.push(raw);
      this.bytes += size;
      this.observed++;
      if (event.type === 'assistant/message') this.lastAnswer = event.data.message;
      if (event.type === 'turn/end') this.lastTurnEnd = event.data;
    } catch (error) {
      // Upstream contains post-append observer exceptions. A sticky failure
      // checked by every barrier is required; throwing here alone is unsafe.
      this.latch(error);
    }
  }

  request(method: string, params: unknown): Promise<any> {
    const next = this.tail.then(async () => {
      this.assertHealthy();
      const count = this.queue.length;
      const batch = '[' + this.queue.join(',') + ']';
      const start = this.acknowledged;
      const result: any = await this.exchange({method, params, events: JSON.parse(batch), event_start: start, event_end: start + count});
      if (method === 'checkpoint' && (result?.persisted !== true || !/^[a-f0-9]{64}$/.test(result.manifest_hash))) {
        throw new Error('invalid durable checkpoint acknowledgement');
      }
      this.assertHealthy();
      // Events appended while awaiting acknowledgement stay in the queue.
      this.queue.splice(0, count);
      this.acknowledged += count;
      this.bytes = 2 + this.queue.reduce((n, s) => n + Buffer.byteLength(s), 0) + Math.max(0, this.queue.length - 1);
      return result;
    }).catch(error => { throw this.latch(error); });
    this.tail = next.catch(() => undefined);
    return next;
  }

  stats() { return {pendingBytes: this.bytes, pendingEvents: this.queue.length, observed: this.observed, acknowledged: this.acknowledged, failed: !!this.failed}; }
}

// Include the stable read operation ID even when state is unchanged: assembly
// precedes automatic compaction, so a fresh snapshot must survive that compaction.
export function workingContext(reply: any, runID: string): string {
  if (!reply || typeof reply.operation_id !== 'string' || !reply.operation_id.startsWith(runID + '/working-state/') ||
      reply.view?.run_id !== runID || !Number.isSafeInteger(reply.view.revision) || reply.view.revision < 0 ||
      !Number.isSafeInteger(reply.view.rule_revision) || typeof reply.view.task !== 'string' ||
      !Array.isArray(reply.view.constraints)) throw new Error('invalid frozen working-state reply');
  const view = reply.view;
  // Fixed field order/version is part of the replay protocol. Original task and
  // read-time constraints are retained. Receipt references already live in the
  // working set; redundant response hashes remain in Runtime's frozen reply.
  const projection = {format:1,operation_id:reply.operation_id,view:{run_id:view.run_id,
    task:view.task,constraints:view.constraints,rule_revision:view.rule_revision,
    revision:view.revision,source_rule_revision:view.source_rule_revision,stale:view.stale,state:view.state}};
  const text = WORKING_CONTEXT_MARKER + 'BEGIN_WORKING_STATE_DATA\n' + JSON.stringify(projection) + '\nEND_WORKING_STATE_DATA';
  // Match the Worker's bounded HTTP reply transport, with framing allowance.
  // The old 64 KiB cap wrongly rejected valid large tasks/working sets even
  // when their configured model window was sufficient. No content is truncated.
  if (Buffer.byteLength(text) > (4 << 20) + 1024) throw new Error('working context exceeds transport budget');
  return text;
}

const text = {type:'string', minLength:1, maxLength:1200};
const id = {type:'string', minLength:1, maxLength:80};
const record = (properties: Record<string, unknown>) => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const list = (items: unknown, maxItems: number) => ({type:'array', items, maxItems});
export const WorkingStateTool = {
  name:'working_state_update',
  description:'Persist the complete bounded working set using the revision from the latest AGENTOS_WORKING_STATE_V1 snapshot. Save useful questions, evidence, conflicts and next steps after meaningful progress. Observations must cite this run’s platform tool operation_id with committed=true. Separate observations, plans and third-party forecasts; a receipt proves retrievability, not truth. This cannot change the user task or constraints. A rejection leaves the previous state unchanged.',
  inputSchema:record({
    expected_revision:{type:'integer', minimum:0}, reason:{...text,maxLength:500},
    state:record({format:{type:'integer',const:1},phase:{...text,maxLength:200},
      questions:list(record({id,text,status:{enum:['open','answered','deferred']}}),16),
      observations:list(record({id,kind:{enum:['observation','plan','third_party_forecast']},text,receipts:{...list({type:'string',minLength:1,maxLength:240},8),minItems:1}}),32),
      conflicts:list(record({id,text,observations:{...list(id,8),minItems:2}}),16),
      next_steps:list(record({id,text,status:{enum:['pending','done','blocked']}}),16),
    }),
  }),
};
