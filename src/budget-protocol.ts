import {CONTEXT_WINDOW_EXCEEDED_CODE,LlmError} from '@deepseek-ai/dsh-llm';

const count=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
const record=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const only=(x:Record<string,any>,keys:string[])=>Object.keys(x).every(k=>keys.includes(k));

// All values originate in the immutable run snapshot, never in model output.
export function budgetConfig(cfg:any) {
  if(!count(cfg?.model_max_tokens)||cfg.model_max_tokens<1||cfg.model_max_tokens>32768||
    !count(cfg?.context_tokens)||cfg.context_tokens<8192||cfg.context_tokens>1000000||
    cfg.model_max_tokens+512>=cfg.context_tokens)throw new Error('invalid source model output/context configuration');
  return Object.freeze({output:cfg.model_max_tokens,compact:Math.min(2048,cfg.model_max_tokens)});
}

// A normal result envelope is delivered only after Runtime's durable response.
// Pipe/network errors never reach this function as a context rejection.
export function budgetModelReply(value:any,contextTokens:number,maxTokens:number) {
  if(!record(value)||value.format!==1)throw new Error('invalid durable model envelope');
  if(value.kind==='context_rejected'){
    if(!only(value,['format','kind','code','not_sent','request_sha256','estimated_input_tokens','max_tokens','context_tokens'])||
      value.code!==CONTEXT_WINDOW_EXCEEDED_CODE||value.not_sent!==true||
      typeof value.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.request_sha256)||
      !count(value.estimated_input_tokens)||value.context_tokens!==contextTokens||value.max_tokens!==maxTokens||
      value.estimated_input_tokens+value.max_tokens<=contextTokens)
      throw new Error('invalid pre-send context rejection');
    // The upstream request-error hook bounds retries and requires surface progress.
    throw new LlmError('Final serialized request exceeds the configured context before provider transmission',CONTEXT_WINDOW_EXCEEDED_CODE);
  }
  if(value.kind!=='completion'||!only(value,['format','kind','message','usage'])||
    !record(value.message)||value.message.role!=='assistant')throw new Error('invalid durable model completion');
  let usage;
  if(value.usage!==undefined&&value.usage!==null){
    const u=value.usage;
    if(!record(u)||!only(u,['prompt_tokens','completion_tokens','cached_prompt_tokens'])||
      !count(u.prompt_tokens)||!count(u.completion_tokens)||!count(u.cached_prompt_tokens)||
      u.cached_prompt_tokens>u.prompt_tokens||!Number.isSafeInteger(u.prompt_tokens+u.completion_tokens))
      throw new Error('invalid persisted provider usage');
    // DeepSeek's prompt counter includes cache hits; DSH's counters are disjoint.
    usage={inputTokens:u.prompt_tokens-u.cached_prompt_tokens,outputTokens:u.completion_tokens,
      cacheReadTokens:u.cached_prompt_tokens,totalTokens:u.prompt_tokens+u.completion_tokens};
  }
  return {message:value.message,usage};
}
