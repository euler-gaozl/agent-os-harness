import {CONTEXT_WINDOW_EXCEEDED_CODE,LlmError} from '@deepseek-ai/dsh-llm';
import {budgetModelReply} from './budget-protocol';

const count=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
const record=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const hash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const only=(x:Record<string,any>,keys:string[])=>Object.keys(x).every(k=>keys.includes(k));

// Both purposes use the provider's actual maximum, frozen by Registry. This is
// permission to generate up to the maximum, not a request to fill the window.
export function nativeConfig(cfg:any) {
  const m=cfg?.model_limits;
  if(!record(m)||m.protocol!=='openai-chat-completions'||m.model!==cfg.model||
    !count(m.context_window)||!count(m.max_output_tokens)||m.context_window>Number.MAX_SAFE_INTEGER/2||
    m.max_output_tokens>m.context_window||m.context_window!==cfg.context_tokens||
    m.max_output_tokens!==cfg.model_max_tokens||!hash(m.metadata_sha256)||
    typeof m.observed_at!=='string'||!Number.isFinite(Date.parse(m.observed_at))||
    typeof m.base_url!=='string'||m.source!==m.base_url+'/models')
    throw new Error('missing or inconsistent native model capability observation');
  const endpoint=new URL(m.base_url);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)
    throw new Error('invalid native model capability endpoint');
  return Object.freeze({output:m.max_output_tokens,compact:m.max_output_tokens});
}

// Native v4 never reports an estimated pre-send rejection as provider-confirmed.
// The supervisor freezes the HTTP status and both request/response digests after
// committing the real attempt. Unknown transmission must stay outside this path.
export function nativeModelReply(value:any,contextTokens:number,maxTokens:number) {
  if(!record(value)||value.format!==2)throw new Error('invalid native durable model envelope');
  if(value.kind==='provider_context_rejected') {
    if(!only(value,['format','kind','code','not_sent','http_status','request_sha256','response_sha256','max_tokens','context_tokens'])||
      value.code!==CONTEXT_WINDOW_EXCEEDED_CODE||value.not_sent!==false||value.http_status!==400||
      !hash(value.request_sha256)||!hash(value.response_sha256)||
      value.context_tokens!==contextTokens||value.max_tokens!==maxTokens)
      throw new Error('invalid persisted provider context rejection');
    throw new LlmError('Provider rejected the persisted request because its shared context window was exceeded',CONTEXT_WINDOW_EXCEEDED_CODE);
  }
  // The completion/usage semantics are identical; only the envelope version is
  // new. budgetModelReply itself remains byte-preserved for historical runners.
  if(value.kind!=='completion')throw new Error('invalid native durable completion');
  return budgetModelReply({...value,format:1},contextTokens,maxTokens);
}

export function assertNativeSummary(input:any[],summary:any[]) {
  const source=JSON.stringify(input),result=JSON.stringify(summary);
  if(!Array.isArray(input)||!Array.isArray(summary)||!input.length||!summary.length||
    Buffer.byteLength(result)>=Buffer.byteLength(source))
    throw new Error('compaction did not reduce the retained representation');
}
