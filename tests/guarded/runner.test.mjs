import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SOURCE_ENGINE,FinalTurnSelection,finalOutputPolicy,selectionReceipt} from '../../.work/guarded-candidate/dist/kernel.mjs';

const entry=fileURLToPath(new URL('../../.work/guarded-candidate/source-runner.mjs',import.meta.url));
const policy={protocol:'receipt-field-v1',tool:'check_draft',input_field:'draft',ready_path:['structuredContent','ready']};
const draft='中文 🙂 e\u0301\r\n{{untrusted}}\n'+('source evidence and checked content。\n'.repeat(6000))+'END  \n';
const sha=text=>createHash('sha256').update(text).digest('hex');
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const envelope=(message,pressure=false)=>({format:2,kind:'completion',message,
  usage:{prompt_tokens:pressure?1000000:1800,completion_tokens:100,cached_prompt_tokens:900}});

// Real DSH/Node process, synthetic supervisor. Runtime SQL is a separate gate.
async function drive(t,{replay=[],killPoint,killAfterReply=false,mixed=false,noPolicy=false,
  directText=false,rejectSelect=false,malformedSelect=false,rejectFinish=false,badArguments=false,
  failResultFlush=false,history=0,pressure=false,badToolArgs=false,remoteToolError=false}={}) {
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','TMP','TEMP'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(process.execPath,['--no-global-search-paths','--max-old-space-size=512',entry],
    {cwd:path.dirname(entry),env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const exited=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('exit',(code,signal)=>resolve({code,signal}));});
  t.after(async()=>{child.kill();await exited;});
  let stderr='';child.stderr.on('data',data=>{stderr=(stderr+data).slice(-24000);});
  const send=v=>child.stdin.write(JSON.stringify(v)+'\n');
  send({type:'init',engine:SOURCE_ENGINE,evidence_protocol:1,run_id:'final-fixture',model:'controlled',context_tokens:1048576,
    model_max_tokens:393216,model_limits:{model:'controlled',base_url:'https://api.deepseek.com',protocol:'openai-chat-completions',context_window:1048576,max_output_tokens:393216,source:'https://api.deepseek.com/models',observed_at:'2026-10-14T10:41:17Z',metadata_sha256:'a'.repeat(64)},
    system:'Collect and check evidence. Do not invent facts.',task:'Return the retained checked text exactly.',
    ...noPolicy?{}:{final_output:policy},tools:[
      {name:'read_evidence',description:'Read source.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:1200}},additionalProperties:false}},
      {name:'check_draft',description:'Check candidate.',inputSchema:{type:'object',properties:{draft:{type:'string'}},required:['draft'],additionalProperties:false}},
    ]});
  const saved=[],events=[];
  let sequence=0,cursor=0,generations=0,summaries=0,reads=0,checks=0,selects=0,finishes=0,newModels=0;
  let candidate,chosen,finished=false,failed=false,killed=false,barrier=false,last='start';
  for await(const line of createInterface({input:child.stdout})) {
    const f=JSON.parse(line);
    assert.equal(f.id,++sequence);assert.equal(f.event_start,cursor);assert.equal(f.event_end,cursor+f.events.length);
    cursor=f.event_end;events.push(...f.events);
    if(barrier)assert.fail('effect crossed failed durability barrier');
    if(f.method==='model') {
      if(f.params.purpose==='compaction')summaries++;else generations++;
      if(sequence>replay.length)newModels++;
    }
    let result;
    if(sequence<=replay.length) {
      const old=replay[sequence-1];
      assert.equal(f.method,old.frame.method,'replay frame order');assert.deepEqual(f.params,old.frame.params,'replay frozen input');
      result=structuredClone(old.result);
    } else if(f.method==='checkpoint') {
      if(failResultFlush&&f.events.some(e=>e.type==='tool/result'&&e.data.message.source.callId.startsWith('commit-'))) {
        barrier=true;send({id:f.id,error:{message:'injected checkpoint loss'}});continue;
      }
      result={persisted:true,manifest_hash:'c'.repeat(64)};
    } else if(f.method==='working_state_read') {
      result={operation_id:`final-fixture/working-state/${f.id}`,view:{run_id:'final-fixture',revision:0,rule_revision:1,
        source_rule_revision:0,stale:false,task:'Return retained text',constraints:['Preserve dates and units'],state:null,evidence:[]}};
    } else if(f.method==='model') {
      if(f.params.purpose==='compaction') result=envelope({role:'assistant',content:'Continuity checkpoint: use the retained candidate receipt and original evidence.'});
      else if(noPolicy||directText||malformedSelect&&selects>0)result=envelope({role:'assistant',content:'Ordinary answer'});
      else if(badToolArgs&&reads===0) result=envelope({role:'assistant',content:'',tool_calls:[call('page-'+generations,'read_evidence',{limit:generations===1?2400:1200})]});
      else if(reads<history) result=envelope({role:'assistant',content:'',tool_calls:[call(`read-${reads}`,'read_evidence',{})]},pressure&&reads===history-1);
      else if(last==='start'||last==='read'||last==='reject-select'||last==='reject-finish')
        result=envelope({role:'assistant',content:'',tool_calls:[call(`check-${checks}`,'check_draft',{draft})]});
      else {
        const commit=call(`commit-${selects}`,'final_output_commit',{operation_id:candidate.operation_id,sha256:candidate.sha256});
        if(badArguments&&generations===history+2)commit.function.arguments='{';
        const other=call('extra','read_evidence',{});
        result=envelope({role:'assistant',content:'',tool_calls:mixed==='before'?[other,commit]:mixed==='after'?[commit,other]:[commit]});
      }
    } else if(f.method==='tool') {
      const op=`final-fixture/dsh/${f.id}`;
      if(badToolArgs&&f.params.name==='read_evidence')assert.equal(f.params.arguments.limit,1200,'bad arguments must never reach supervisor');
      if(remoteToolError){barrier=true;send({id:f.id,error:{message:String(remoteToolError)}});continue;}
      if(f.params.name==='check_draft')result=JSON.stringify({result:JSON.stringify({structuredContent:{ready:true}}),receipt:{operation_id:op,committed:true,final_output:{protocol:'receipt-field-v1',sha256:sha(f.params.arguments.draft),ready:true}}});
      else result=JSON.stringify({result:'Original evidence. '.repeat(5000),receipt:{operation_id:op,committed:true}});
    } else if(f.method==='final_output_select') {
      assert.equal(f.params.operation_id,candidate.operation_id);assert.equal(f.params.sha256,candidate.sha256);
      result=rejectSelect&&selects===0?{selected:false,continue:'Recheck the candidate under current constraints.'}:
        {selected:true,selection_id:`final-fixture/dsh/${f.id}`,operation_id:candidate.operation_id,
          sha256:malformedSelect?'wrong':candidate.sha256,policy_sha256:'d'.repeat(64),rule_revision:1};
    } else if(f.method==='finish_ref') {
      assert.equal(f.params.selection_id,chosen.selection_id);
      const committedEvents=saved.flatMap(x=>x.frame.events);
      assert.ok(committedEvents.some(e=>e.type==='tool/result'&&e.data.message.source.callId.startsWith('commit-')&&e.data.message.isError===false),'tool result must be acknowledged before finish');
      assert.ok(committedEvents.some(e=>e.type==='turn/end'&&e.data.reason.kind==='completed'),'turn end must be acknowledged before finish');
      result=rejectFinish&&finishes===0?{done:false,continue:'Constraints changed. Check and select a fresh candidate.'}:
        {done:true,selection_id:chosen.selection_id,sha256:chosen.sha256};
    } else if(f.method==='finish') {assert.equal(noPolicy,true);result={done:true};}
    else if(f.method==='failed')result={};
    else assert.fail('unexpected frame '+f.method);

    // Reconstruct the fixture's authoritative state identically during replay.
    if(f.method==='tool') {
      if(f.params.name==='check_draft'){checks++;const r=JSON.parse(result).receipt;candidate={operation_id:r.operation_id,...r.final_output};last='check';}
      else {reads++;last='read';}
    }
    if(f.method==='final_output_select'){selects++;chosen=result.selected?result:null;last=chosen?'selected':'reject-select';}
    if(f.method==='finish_ref'){finishes++;finished=result.done===true;last=finished?'finished':'reject-finish';}
    if(f.method==='finish')finished=true;
    if(f.method==='failed')failed=true;
    saved.push({frame:f,result:structuredClone(result)});
    const point=f.method==='final_output_select'?'select':f.method==='finish_ref'?'finish':
      f.method==='checkpoint'&&f.events.some(e=>e.type==='tool/result'&&e.data.message.source.callId.startsWith('commit-'))?'result-flush':
      f.method==='checkpoint'&&f.events.some(e=>e.type==='tool/result'&&e.data.message.isError===true)?'argument-error':null;
    if(killPoint&&point===killPoint){killed=true;if(killAfterReply)send({id:f.id,result});child.kill();break;}
    send({id:f.id,result});
  }
  const exit=await exited;
  if(!killed&&!barrier)assert.equal(exit.code,finished?0:1,stderr);
  return {saved,events,generations,newModels,summaries,reads,checks,selects,finishes,finished,failed,barrier,killed,stderr};
}

test('checked Unicode and long text is sent once; final delivery is a bounded reference',{timeout:30000},async t=>{
  const a=await drive(t);assert.equal(a.finished,true,a.stderr);assert.equal(a.generations,2);
  const input=a.saved.find(x=>x.frame.method==='tool').frame.params.arguments.draft;assert.equal(input,draft);
  const finish=a.saved.find(x=>x.frame.method==='finish_ref');assert.deepEqual(Object.keys(finish.frame.params),['selection_id']);
  assert.ok(JSON.stringify(finish.frame.params).length<100);assert.equal(finish.result.sha256,sha(draft));
  assert.equal(a.saved.some(x=>x.frame.method==='finish'),false);
  const b=await drive(t,{replay:a.saved});assert.equal(b.finished,true);assert.equal(b.newModels,0);
});
for(const mixed of ['before','after'])test(`mixed commit batch rejects ${mixed} tools before any dispatch`,{timeout:20000},async t=>{
  const a=await drive(t,{mixed});assert.equal(a.finished,false);assert.equal(a.failed,true);assert.equal(a.reads,0);assert.equal(a.selects,0);
});
test('rejected selection remains in the official loop and requires a new check',{timeout:20000},async t=>{
  const a=await drive(t,{rejectSelect:true});assert.equal(a.finished,true);assert.equal(a.selects,2);assert.equal(a.checks,2);
});
test('malformed model arguments can be corrected through the official tool loop',{timeout:20000},async t=>{
  const a=await drive(t,{badArguments:true});assert.equal(a.finished,true,a.stderr);assert.equal(a.selects,1);assert.equal(a.generations,3);
  assert.ok(a.events.some(e=>e.type==='tool/result'&&e.data.message.isError===true));
});
test('changed constraints after selection require fresh candidate and selection',{timeout:20000},async t=>{
  const a=await drive(t,{rejectFinish:true});assert.equal(a.finished,true);assert.equal(a.finishes,2);assert.equal(a.checks,2);assert.equal(a.selects,2);
});
test('policy does not fall back to a normal text finish',{timeout:20000},async t=>{
  const a=await drive(t,{directText:true});assert.equal(a.finished,false);assert.equal(a.failed,true);assert.equal(a.finishes,0);
});
test('malformed selection cannot produce a completed result',{timeout:20000},async t=>{
  const a=await drive(t,{malformedSelect:true});assert.equal(a.finished,false);assert.equal(a.failed,true);assert.equal(a.finishes,0);
});
test('failed tool result persistence prevents finish_ref',{timeout:20000},async t=>{
  const a=await drive(t,{failResultFlush:true});assert.equal(a.barrier,true);assert.equal(a.finishes,0);assert.equal(a.finished,false);
});
test('v6 without policy preserves ordinary text delivery',{timeout:20000},async t=>{
  const a=await drive(t,{noPolicy:true});assert.equal(a.finished,true);assert.equal(a.selects,0);assert.equal(a.finishes,0);
});
for(const killPoint of ['select','result-flush','finish'])for(const killAfterReply of [false,true])
test(`kill at ${killPoint}, reply ${killAfterReply?'sent':'lost'} replays without another provider request`,{timeout:30000},async t=>{
  const a=await drive(t,{killPoint,killAfterReply});assert.equal(a.killed,true);
  const b=await drive(t,{replay:a.saved});assert.equal(b.finished,true,b.stderr);assert.equal(b.newModels,0);
});
test('official pressure compaction and replay retain candidate reference',{timeout:30000},async t=>{
  const a=await drive(t,{history:12,pressure:true});assert.equal(a.finished,true,a.stderr);assert.ok(a.summaries>0);
  const b=await drive(t,{history:12,pressure:true,replay:a.saved});assert.equal(b.finished,true);assert.equal(b.newModels,0);
});

test('output failure and later assistant events invalidate an in-memory selection',()=>{
  const tracker=new FinalTurnSelection('r');
  const args={operation_id:'r/dsh/3',sha256:'a'.repeat(64)};
  const reply={selected:true,selection_id:'r/dsh/8',...args,policy_sha256:'b'.repeat(64),rule_revision:1};
  const assistant={type:'assistant/message',data:{turn:1,step:2,message:{content:[{type:'tool-call',id:'c',name:'final_output_commit',arguments:JSON.stringify(args)}]}}};
  const result={type:'tool/result',data:{turn:1,step:2,message:{source:{callId:'c'},isError:false,content:[{type:'text',text:JSON.stringify(reply)}]}}};
  const end={turn:1,reason:{kind:'completed'}};
  tracker.observe(assistant);tracker.observe({...result,data:{...result.data,message:{...result.data.message,isError:true}}});assert.equal(tracker.completed(end),null);
  tracker.observe(result);assert.deepEqual(tracker.completed(end),reply);assert.equal(tracker.completed({turn:2,reason:{kind:'completed'}}),null);
  tracker.observe({type:'assistant/message',data:{turn:1,step:3,message:{content:[{type:'text',text:'later answer'}]}}});assert.equal(tracker.completed(end),null);
});
test('unbound and malformed frozen policy or selection is rejected',()=>{
  assert.throws(()=>finalOutputPolicy({final_output:policy,tools:[]}));
  for(const ready_path of [[],['content','0'],Array(9).fill('x')])assert.throws(()=>finalOutputPolicy({final_output:{...policy,ready_path},tools:[{name:'check_draft'}]}));
  for(const selected of ['true',null,0])assert.throws(()=>selectionReceipt({selected},{},'r'));
});

test('invalid paging arguments become an error result; correction finishes exact delivery',{timeout:30000},async t=>{
  const a=await drive(t,{badToolArgs:true});assert.equal(a.finished,true,a.stderr);assert.equal(a.generations,4);assert.equal(a.reads,1);
  const errors=a.events.filter(e=>e.type==='tool/result'&&e.data.message.isError===true);
  assert.equal(errors.length,1);assert.match(JSON.stringify(errors[0]),/INVALID_TOOL_ARGUMENTS/);
  assert.equal(a.saved.filter(x=>x.frame.method==='tool'&&x.frame.params.name==='read_evidence').length,1);
  const b=await drive(t,{badToolArgs:true,replay:a.saved});assert.equal(b.finished,true,b.stderr);assert.equal(b.newModels,0);
});
for(const killAfterReply of [false,true])test(`argument error durability checkpoint replays, reply ${killAfterReply}`,{timeout:30000},async t=>{
  const a=await drive(t,{badToolArgs:true,killPoint:'argument-error',killAfterReply});assert.equal(a.killed,true);assert.equal(a.reads,0);
  const b=await drive(t,{badToolArgs:true,replay:a.saved});assert.equal(b.finished,true,b.stderr);assert.equal(b.reads,1);assert.equal(b.newModels,3);
});
for(const remoteToolError of ['HTTP 400','HTTP 403','timeout with unknown effect'])test(`remote ${remoteToolError} remains a durability failure`,{timeout:20000},async t=>{
  const a=await drive(t,{remoteToolError});assert.equal(a.barrier,true);assert.equal(a.finished,false);assert.equal(a.newModels,1);
});
