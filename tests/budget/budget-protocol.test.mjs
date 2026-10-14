import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgetConfig,budgetModelReply} from '../../.work/budget-candidate/dist/kernel.mjs';

test('output and compaction budgets come from the fixed configuration',()=>{
  assert.deepEqual(budgetConfig({model_max_tokens:6144,context_tokens:32000}),{output:6144,compact:2048});
  assert.deepEqual(budgetConfig({model_max_tokens:1024,context_tokens:8192}),{output:1024,compact:1024});
  for(const cfg of [{context_tokens:32000},{model_max_tokens:0,context_tokens:32000},
    {model_max_tokens:32769,context_tokens:64000},{model_max_tokens:7800,context_tokens:8192},
    {model_max_tokens:1.5,context_tokens:32000}])assert.throws(()=>budgetConfig(cfg));
});

const complete={format:1,kind:'completion',message:{role:'assistant',content:'fixture'}};
test('persisted usage uses disjoint cache buckets; absent usage stays absent',()=>{
  assert.deepEqual(budgetModelReply({...complete,usage:{prompt_tokens:200,completion_tokens:50,cached_prompt_tokens:120}},32000,6144).usage,
    {inputTokens:80,outputTokens:50,cacheReadTokens:120,totalTokens:250});
  assert.equal(budgetModelReply(complete,32000,6144).usage,undefined);
  assert.equal(budgetModelReply({...complete,usage:null},32000,6144).usage,undefined);
  for(const usage of [{},{prompt_tokens:10,completion_tokens:0},{prompt_tokens:10,completion_tokens:-1,cached_prompt_tokens:0},
    {prompt_tokens:10,completion_tokens:0,cached_prompt_tokens:11},{prompt_tokens:10.1,completion_tokens:0,cached_prompt_tokens:0},
    {prompt_tokens:Number.MAX_SAFE_INTEGER,completion_tokens:1,cached_prompt_tokens:0}])
    assert.throws(()=>budgetModelReply({...complete,usage},32000,6144),/invalid persisted provider usage/);
});

test('only a verified pre-send rejection becomes the official context error',()=>{
  const rejected={format:1,kind:'context_rejected',code:'CONTEXT_WINDOW_EXCEEDED',not_sent:true,
    request_sha256:'a'.repeat(64),estimated_input_tokens:27000,max_tokens:6144,context_tokens:32000};
  assert.throws(()=>budgetModelReply(rejected,32000,6144),e=>e.code==='CONTEXT_WINDOW_EXCEEDED');
  for(const change of [{not_sent:false},{context_tokens:64000},{max_tokens:4096},{request_sha256:'bad'},
    {estimated_input_tokens:100},{code:'NETWORK_ERROR'},{extra:'unexpected'}])
    assert.throws(()=>budgetModelReply({...rejected,...change},32000,6144),e=>e.code!=='CONTEXT_WINDOW_EXCEEDED');
});
