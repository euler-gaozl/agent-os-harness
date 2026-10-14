import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeConfig,nativeModelReply,assertNativeSummary} from '../../.work/native-candidate/dist/kernel.mjs';

const limits={model:'controlled',base_url:'https://api.deepseek.com',protocol:'openai-chat-completions',
  context_window:1048576,max_output_tokens:393216,source:'https://api.deepseek.com/models',
  observed_at:'2026-10-14T10:41:17Z',metadata_sha256:'a'.repeat(64)};
const cfg={model:'controlled',model_limits:limits,context_tokens:1048576,model_max_tokens:393216};

test('generation and compaction use the frozen provider maximum, with no old small caps',()=>{
  assert.deepEqual(nativeConfig(cfg),{output:393216,compact:393216});
  for(const change of [{model_limits:null},{model:'other'},{context_tokens:1000000},{model_max_tokens:32768},
    {model_limits:{...limits,protocol:'other'}},{model_limits:{...limits,metadata_sha256:'bad'}},
    {model_limits:{...limits,observed_at:'unknown'}},{model_limits:{...limits,source:'https://wrong.invalid/models'}},
    {model_limits:{...limits,context_window:9007199254740991}},{model_limits:{...limits,max_output_tokens:1048577}}])
    assert.throws(()=>nativeConfig({...cfg,...change}));
});

test('native replies distinguish sent provider rejection from pre-send and uncertain failures',()=>{
  const rejected={format:2,kind:'provider_context_rejected',code:'CONTEXT_WINDOW_EXCEEDED',not_sent:false,http_status:400,
    request_sha256:'b'.repeat(64),response_sha256:'c'.repeat(64),context_tokens:1048576,max_tokens:393216};
  assert.throws(()=>nativeModelReply(rejected,1048576,393216),e=>e.code==='CONTEXT_WINDOW_EXCEEDED');
  for(const change of [{format:1},{kind:'context_rejected'},{not_sent:true},{http_status:401},{http_status:500},
    {response_sha256:'bad'},{request_sha256:null},{context_tokens:32000},{max_tokens:4096},{code:'NETWORK'},
    {estimated_input_tokens:2000000}])
    assert.throws(()=>nativeModelReply({...rejected,...change},1048576,393216),e=>e.code!=='CONTEXT_WINDOW_EXCEEDED');
});

test('normal receipts retain actual usage without rounding or loss',()=>{
  const reply={format:2,kind:'completion',message:{role:'assistant',content:'完整结果'},
    usage:{prompt_tokens:500000,completion_tokens:100000,cached_prompt_tokens:400000}};
  assert.deepEqual(nativeModelReply(reply,1048576,393216),{message:reply.message,
    usage:{inputTokens:100000,outputTokens:100000,cacheReadTokens:400000,totalTokens:600000}});
  assert.throws(()=>nativeModelReply({...reply,usage:{...reply.usage,cached_prompt_tokens:600000}},1048576,393216));
});

test('a verbose non-reducing summary is rejected rather than retried indefinitely',()=>{
  const input=[{role:'user',content:[{type:'text',text:'original '.repeat(100)}]}];
  assertNativeSummary(input,[{type:'text',text:'Concise checkpoint.'}]);
  assert.throws(()=>assertNativeSummary(input,[{type:'text',text:'expanded '.repeat(1000)}]),/did not reduce/);
  assert.throws(()=>assertNativeSummary([],[]),/did not reduce/);
});
