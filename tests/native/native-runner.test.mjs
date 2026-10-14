import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {SOURCE_ENGINE} from '../../.work/native-candidate/dist/kernel.mjs';

const entry=fileURLToPath(new URL('../../.work/native-candidate/source-runner.mjs',import.meta.url));
const task='比较供给与库存，保留原始日期与单位。引号 "，换行\n，字面 {{untrusted}}。';
const usage={prompt_tokens:1800,completion_tokens:100,cached_prompt_tokens:900};
const envelope=(message,u=usage)=>({format:2,kind:'completion',message,usage:u});
const rejection=(frame)=>({format:2,kind:'provider_context_rejected',code:'CONTEXT_WINDOW_EXCEEDED',not_sent:false,http_status:400,response_sha256:'d'.repeat(64),
  request_sha256:'b'.repeat(64),max_tokens:frame.params.max_tokens,context_tokens:1048576});

// Real source-built DSH process; the supervisor here is a protocol fixture, not PostgreSQL or a provider.
async function drive(t,{rejectAt=0,alwaysReject=false,rejectSummary=false,transportFail=false,failCheckpoint=false,
  pressure=false,largeHistory=false,history=6,replay=[],killAt,killAfterReply=false,longOutput=false,taskText=task,outputText}={}) {
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','TMP','TEMP'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(process.execPath,['--no-global-search-paths','--max-old-space-size=512',entry],
    {cwd:path.dirname(entry),env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const exited=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('exit',(code,signal)=>resolve({code,signal}));});
  t.after(async()=>{child.kill();await exited;});
  let stderr='';child.stderr.on('data',data=>{stderr=(stderr+data).slice(-24000);});
  const send=v=>child.stdin.write(JSON.stringify(v)+'\n');
  send({type:'init',engine:SOURCE_ENGINE,evidence_protocol:1,run_id:'native-fixture',model:'controlled',context_tokens:1048576,
    model_max_tokens:393216,model_limits:{model:'controlled',base_url:'https://api.deepseek.com',protocol:'openai-chat-completions',context_window:1048576,max_output_tokens:393216,source:'https://api.deepseek.com/models',observed_at:'2026-10-14T10:41:17Z',metadata_sha256:'a'.repeat(64)},system:'Separate facts from plans. {{literal}}',task:taskText,
    tools:[{name:'read_evidence',description:'Read a controlled source.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
  const saved=[],events=[];
  let sequence=0,cursor=0,generations=0,summaries=0,rejections=0,barrier=false,finished=false,failed=false,killed=false;
  for await(const line of createInterface({input:child.stdout})) {
    const f=JSON.parse(line);
    assert.equal(f.id,++sequence);assert.equal(f.event_start,cursor);assert.equal(f.event_end,cursor+f.events.length);
    cursor=f.event_end;events.push(...f.events);
    if(barrier)assert.fail('effect crossed a failed durability barrier');
    let result;
    if(f.method==='model') {
      if(f.params.purpose==='compaction'){summaries++;assert.equal(f.params.max_tokens,393216);}
      else {generations++;assert.equal(f.params.purpose,'generation');assert.equal(f.params.max_tokens,393216);}
    }
    if(sequence<=replay.length) {
      const old=replay[sequence-1];
      assert.equal(f.method,old.frame.method,'restart frame order changed');
      assert.deepEqual(f.params,old.frame.params,'restart changed frozen input');
      result=structuredClone(old.result);
      if(result?.kind==='provider_context_rejected')rejections++;
    } else if(f.method==='checkpoint') {
      if(failCheckpoint&&f.events.some(e=>e.type==='compaction/end')) {
        barrier=true;send({id:f.id,error:{message:'controlled checkpoint loss'}});continue;
      }
      result={persisted:true,manifest_hash:'c'.repeat(64)};
    } else if(f.method==='working_state_read') {
      result={operation_id:`native-fixture/working-state/${f.id}`,view:{run_id:'native-fixture',revision:0,rule_revision:1,
        source_rule_revision:0,stale:false,task:taskText,constraints:['2026-10-01 实际库存17万吨，计划20万吨；来源证据需回查。'],state:null,evidence:[]}};
    } else if(f.method==='model') {
      if(f.params.purpose==='compaction') result=rejectSummary?rejection(f):envelope({role:'assistant',content:'Short continuity checkpoint; the frozen state retains exact dates.'});
      else if(rejectAt&&(generations===rejectAt||alwaysReject&&generations>=rejectAt)) {
        if(transportFail){barrier=true;send({id:f.id,error:{message:'controlled network/fence failure'}});continue;}
        result=rejection(f);
      } else if(generations<=history) result=envelope({role:'assistant',content:'',tool_calls:[{id:'call-'+generations,type:'function',function:{name:'read_evidence',arguments:'{}'}}]},
        pressure&&generations===history?{prompt_tokens:1000000,completion_tokens:100,cached_prompt_tokens:900}:usage);
      else result=envelope({role:'assistant',content:outputText??(longOutput?'result '.repeat(60000):'2026-10-01 实际库存17万吨。')},
        longOutput?{prompt_tokens:1800,completion_tokens:60000,cached_prompt_tokens:900}:usage);
      if(result.kind==='provider_context_rejected')rejections++;
    } else if(f.method==='tool') result=JSON.stringify({result:'2026-10-01 actual inventory 17 units. Plan 20 units. '+'controlled evidence '.repeat(largeHistory?5000:120)});
    else if(f.method==='finish')result={done:true};
    else if(f.method==='failed')result={};
    else assert.fail('unexpected frame '+f.method);
    saved.push({frame:f,result:structuredClone(result)});
    if(f.method==='finish')finished=true;
    if(f.method==='failed')failed=true;
    if(killAt?.({frame:f,result,events,generations,summaries})) {
      killed=true;if(killAfterReply)send({id:f.id,result});child.kill();break;
    }
    send({id:f.id,result});
  }
  const exit=await exited;
  if(!killed&&!barrier)assert.equal(exit.code,finished?0:1,stderr);
  return {saved,events,generations,summaries,rejections,finished,failed,barrier,killed,stderr};
}

test('native output exceeds 32768 and provider usage is stored and replayed', {timeout:20000},async t=>{
  const a=await drive(t,{history:0,longOutput:true});assert.equal(a.finished,true);
  const assistant=a.events.find(e=>e.type==='assistant/message');
  assert.ok(assistant,JSON.stringify(a.events.map(e=>e.type)));
  assert.ok(JSON.stringify(assistant).includes('60000'),'provider usage absent from durable assistant event');
  assert.equal(a.saved.find(x=>x.frame.method==='finish').frame.params.result,'result '.repeat(60000));
  const b=await drive(t,{history:0,longOutput:true,replay:a.saved});assert.equal(b.finished,true);
});

test('persisted provider rejection enters official compaction, commits replacement, then retries', {timeout:30000},async t=>{
  const a=await drive(t,{rejectAt:7});
  assert.equal(a.rejections,1);assert.ok(a.summaries>0,a.stderr);assert.equal(a.finished,true,a.stderr);
  const rejected=a.saved.findIndex(x=>x.result?.kind==='provider_context_rejected');
  const retry=a.saved.findIndex((x,n)=>n>rejected&&x.frame.method==='model'&&x.frame.params.purpose==='generation');
  assert.ok(retry>rejected);
  assert.ok(a.saved.slice(rejected+1,retry).some(x=>x.frame.method==='checkpoint'&&x.frame.events.some(e=>e.type==='compaction/end')),
    'generation retry was not preceded by acknowledged compaction');
  const retryInput=JSON.stringify(a.saved[retry].frame.params);
  assert.ok(retryInput.includes('17万吨')&&retryInput.includes('{{untrusted}}'));
  const b=await drive(t,{rejectAt:7,replay:a.saved});assert.equal(b.finished,true);
});

test('actual usage triggers pressure compaction while estimated history stays below threshold', {timeout:30000},async t=>{
  // Enough history to leave an older region outside the official retained tail.
  // A tiny surface is deliberately retained even when the measured envelope is large.
  const noUsagePressure=await drive(t,{history:12,largeHistory:true});assert.equal(noUsagePressure.summaries,0);
  const a=await drive(t,{history:12,largeHistory:true,pressure:true});assert.ok(a.summaries>0,a.stderr);assert.equal(a.finished,true);
  const b=await drive(t,{history:12,largeHistory:true,pressure:true,replay:a.saved});assert.equal(b.finished,true);
});

test('multi-megabyte input and output survive the real Node bridge without slicing',{timeout:30000},async t=>{
  // These are byte-capacity fixtures, not a claim about tokenizer counts or a
  // provider having actually generated this synthetic text.
  const taskText='输入资料。'.repeat(300000),outputText='完整输出。'.repeat(350000);
  assert.ok(Buffer.byteLength(taskText)>4<<20);
  assert.ok(Buffer.byteLength(outputText)>4<<20);
  const a=await drive(t,{history:0,taskText,outputText});
  assert.equal(a.finished,true,a.stderr);
  assert.equal(a.saved.find(x=>x.frame.method==='finish').frame.params.result,outputText);
  assert.ok(a.saved.find(x=>x.frame.method==='model').frame.params.messages.some(x=>x.content===taskText));
});

for(const scenario of [
  ['irreducible initial request',{rejectAt:1,history:0}],
  ['summary rejected by provider',{rejectAt:7,rejectSummary:true}],
  ['continued overflow after reductions',{rejectAt:7,alwaysReject:true}],
])test(scenario[0]+' fails within the official retry bounds',{timeout:30000},async t=>{
  const a=await drive(t,scenario[1]);assert.equal(a.finished,false,a.stderr);assert.equal(a.failed,true,a.stderr);
  assert.ok(a.generations<=(scenario[1].rejectAt+2));assert.ok(a.summaries<=2,a.stderr);
});

test('transport failures cannot become recoverable context errors',{timeout:20000},async t=>{
  const a=await drive(t,{rejectAt:7,transportFail:true});assert.equal(a.barrier,true);assert.equal(a.summaries,0);assert.equal(a.finished,false);
});

test('failed compaction checkpoint prevents every subsequent bridge effect',{timeout:30000},async t=>{
  const a=await drive(t,{rejectAt:7,failCheckpoint:true});assert.equal(a.barrier,true,a.stderr);assert.ok(a.summaries>0);assert.equal(a.finished,false);
});

for(const point of ['rejection','replacement'])for(const replied of [false,true])
test(`process killed at ${point}, reply ${replied?'sent':'lost'}, replays frozen inputs`,{timeout:30000},async t=>{
  const a=await drive(t,{rejectAt:7,killAfterReply:replied,killAt:({frame,result})=>point==='rejection'
    ?result?.kind==='provider_context_rejected':frame.method==='checkpoint'&&frame.events.some(e=>e.type==='compaction/end')});
  assert.equal(a.killed,true,a.stderr);
  const b=await drive(t,{rejectAt:7,replay:a.saved});assert.equal(b.finished,true,b.stderr);
});
