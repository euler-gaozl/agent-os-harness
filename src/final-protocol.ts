// This is a new replay protocol. native-v4 remains byte-preserved.
export const FINAL_OUTPUT_TOOL = 'final_output_commit';
const name = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const hash = /^[a-f0-9]{64}$/;

export function finalOutputPolicy(cfg: any): any {
  const p = cfg.final_output;
  if (p === undefined || p === null) return null;
  if (p.protocol !== 'receipt-field-v1' || typeof p.tool !== 'string' || !name.test(p.tool) ||
      p.tool === FINAL_OUTPUT_TOOL || p.tool === 'working_state_update' ||
      typeof p.input_field !== 'string' || !name.test(p.input_field) || !Array.isArray(p.ready_path) ||
      p.ready_path.length < 1 || p.ready_path.length > 8 ||
      p.ready_path.some((key: any) => typeof key !== 'string' || !name.test(key)) ||
      !cfg.tools?.some((tool: any) => tool.name === p.tool)) {
    throw new Error('invalid frozen final output policy');
  }
  return p;
}

// concludeTurn ends the loop only after the entire batch. Reject mixed batches
// before emitting any block to DSH, including tools placed before the commit.
export function assertFinalCallBatch(message: any, policy: any, purpose: string): void {
  const calls = message.tool_calls ?? [];
  if (!calls.some((call: any) => call.function.name === FINAL_OUTPUT_TOOL)) return;
  if (!policy || purpose === 'compaction' || calls.length !== 1) {
    throw new Error('final output commit must be the only tool call in a generation');
  }
}

export function selectionReceipt(reply: any, args: any, runID: string): any {
  if (reply?.selected === false && typeof reply.continue === 'string' &&
      reply.continue.length > 0 && reply.continue.length <= 2000) return null;
  if (reply?.selected !== true || reply.operation_id !== args.operation_id ||
      reply.sha256 !== args.sha256 || !hash.test(reply.sha256) ||
      !hash.test(reply.policy_sha256) || !Number.isSafeInteger(reply.rule_revision) ||
      reply.rule_revision < 0 || typeof reply.selection_id !== 'string' ||
      !reply.selection_id.startsWith(runID + '/dsh/') ||
      !/^[1-9][0-9]*$/.test(reply.selection_id.slice((runID + '/dsh/').length))) {
    throw new Error('invalid committed final output selection');
  }
  return reply;
}

export const FinalOutputTool = {
  name: FINAL_OUTPUT_TOOL,
  description: 'Deliver the exact stored input of the latest eligible candidate tool receipt. Copy operation_id and sha256 from its receipt.final_output; never calculate the hash yourself or rewrite the draft. Call this tool alone in its model message. A selected receipt ends the turn; a rejection explains what to reconsider. Readiness does not establish factual truth.',
  inputSchema: {type: 'object', properties: {
    operation_id: {type: 'string', minLength: 1, maxLength: 240},
    sha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
  }, required: ['operation_id', 'sha256'], additionalProperties: false},
};

export function finalOutputArgs(args: any, runID: string): any {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => !['operation_id','sha256'].includes(key)) ||
      typeof args.operation_id !== 'string' || args.operation_id.length > 240 ||
      !args.operation_id.startsWith(runID + '/dsh/') ||
      !/^[1-9][0-9]*$/.test(args.operation_id.slice((runID + '/dsh/').length)) ||
      typeof args.sha256 !== 'string' || !hash.test(args.sha256)) {
    throw new Error('use operation_id and sha256 from this run candidate receipt');
  }
  return args;
}

// Observe actual successful DSH events, not just a variable set inside execute:
// output rendering/validation, cancellation, or a later step can invalidate it.
export class FinalTurnSelection {
  private call: any = null;
  private selection: any = null;
  private rejection: any = null;
  private failure: Error | null = null;
  constructor(private runID: string) {}
  observe(event: any): void {
    if (this.failure) return;
    try {
      if (event.type === 'turn/start') {
        this.call = null;
        this.selection = null;
        this.rejection = null;
      }
      if (event.type === 'assistant/attempt') {
        // A new attempt invalidates an in-memory selection, but a rejection
        // from the same turn remains actionable until the turn ends.
        this.clear();
      }
      if (event.type === 'assistant/message') {
        this.clear();
        const calls = event.data.message.content.filter((b: any) => b.type === 'tool-call');
        if (calls.length === 1 && calls[0].name === FINAL_OUTPUT_TOOL) {
          let args: any;
          // Model syntax errors are ordinary DSH tool failures, not corruption
          // of a trusted receipt. A corrected subsequent call must recover.
          try { args = JSON.parse(calls[0].arguments); } catch { return; }
          this.call = {id: calls[0].id, args,
            turn: event.data.turn, step: event.data.step};
          this.rejection = null;
        }
      }
      if (event.type === 'tool/result' && this.call &&
          event.data.message.source.callId === this.call.id &&
          event.data.turn === this.call.turn && event.data.step === this.call.step) {
        const m = event.data.message;
        this.selection = null;
        if (m.isError !== false || m.content.length !== 1 || m.content[0].type !== 'text') return;
        const receipt = JSON.parse(m.content[0].text);
        this.selection = selectionReceipt(receipt, this.call.args, this.runID);
        if (this.selection) {
          this.rejection = null;
        } else if (receipt?.selected === false && typeof receipt.continue === 'string') {
          // A bounded business rejection is recoverable inside the same loop.
          // The runner may return it to the model once; it is not a selection.
          this.rejection = {continue: receipt.continue, turn: this.call.turn};
        }
      }
    } catch {
      // Session observers may contain exceptions, so retain a sticky failure.
      this.failure = new Error('invalid final output tool event');
    }
  }
  completed(end: any): any {
    if (this.failure) throw this.failure;
    return end?.reason.kind === 'completed' && end.turn === this.call?.turn ? this.selection : null;
  }
  rejected(end: any): any {
    if (this.failure) throw this.failure;
    // A rejection is cleared at the next turn/start, so it cannot leak into a
    // later turn. Keep it actionable across the model's text-only reply.
    return end?.reason.kind === 'completed' ? this.rejection : null;
  }
  clear(): void { this.call = null; this.selection = null; }
}
