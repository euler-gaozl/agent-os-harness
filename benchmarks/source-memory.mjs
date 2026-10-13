// Controlled source DSH workload, NOT a Runtime/Worker, database or paid-model
// acceptance. Real loop/compaction, bounded supervisor, flushed local journal,
// then a fresh child replays frozen replies and verifies every semantic request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

const root = fileURLToPath(new URL('../', import.meta.url));
const childFile = fileURLToPath(new URL('./source-memory-child.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/manifest.json')));
for (const [file, digest] of [['dist/kernel.mjs',manifest.kernel_sha256],
  ['source-runner.mjs',manifest.source_runner_sha256]]) {
  assert.equal(hash(fs.readFileSync(path.join(root,file))),digest,'built artifact mismatch');
}
const out = process.argv[2];
const steps = (process.argv[3] || '128,512,2048').split(',').map(Number);
assert.ok(out && path.isAbsolute(out), 'explicit absolute evidence directory required');
assert.ok(steps.length <= 8 && steps.every(n => Number.isSafeInteger(n) && n >= 4 && n <= 8192));
fs.mkdirSync(out); // Exclusive: never overwrite previous evidence.
const stride = 64;
const payloadBytes = 4096;
const runID = 'synthetic-memory-benchmark';
const task = 'Synthetic test only: read sequential evidence records, then report the retained quantity and date.';
const init = {type:'init',engine:manifest.source_engine,evidence_protocol:1,run_id:runID,
  model:'fixture-no-provider',context_tokens:8192,system:'Synthetic benchmark. Do not infer market facts.',task,
  tools:[{name:'evidence_read',description:'Read the next synthetic record.',
    inputSchema:{type:'object',properties:{index:{type:'integer',minimum:1}},required:['index'],additionalProperties:false}}]};

async function execute(count, replay) {
  const label = `${count}-${replay ? 'replay' : 'record'}`;
  const journalPath = path.join(out,`${count}-journal.ndjson`);
  const journal = replay ? null : fs.openSync(journalPath,'wx');
  const metrics = fs.openSync(path.join(out,`${label}-metrics.ndjson`),'wx');
  const stderrFile = fs.openSync(path.join(out,`${label}-stderr.log`),'wx');
  const replayStream = replay ? fs.createReadStream(journalPath,{highWaterMark:65536}) : null;
  const replayLines = replayStream ? createInterface({input:replayStream,crlfDelay:Infinity}) : null;
  const iterator = replayLines?.[Symbol.asyncIterator]();
  const env = {};
  for (const name of ['SystemRoot','WINDIR','TMP','TEMP']) if(process.env[name]) env[name]=process.env[name];
  const started = performance.now();
  const child = spawn(process.execPath,['--no-global-search-paths','--max-old-space-size=192',
    '--expose-gc',childFile,String(stride)],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe','ipc']});
  const exit = new Promise(resolve => {child.once('error',error=>resolve({error:String(error)}));
    child.once('close',(code,signal)=>resolve({code,signal}));});
  const summary = {label,completed:false,fixture:true,steps:count,frames:0,events:0,event_bytes:0,
    models:0,summaries:0,tools:0,compactions:0,max_model_json_bytes:0,samples:[],elapsed_ms:0};
  child.on('message',value=>{
    if(value.kind !== 'memory-sample') return;
    summary.samples.push(value); fs.writeSync(metrics,encode(value)+'\n');
  });
  child.stderr.on('data',bytes=>fs.writeSync(stderrFile,bytes));
  let inputError;
  child.stdin.on('error',error=>{inputError=error;});
  const timer = setTimeout(()=>{summary.timeout=true;child.kill();},600000);
  let cursor=0,chain='0'.repeat(64),finished=false,previousIndex=0,toolIndex=0;
  try {
    child.stdin.write(encode(init)+'\n');
    for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})) {
      if (inputError) throw inputError;
      const frame=JSON.parse(line);
      assert.equal(frame.id,++summary.frames);
      assert.equal(frame.event_start,cursor);
      assert.equal(frame.event_end,cursor+frame.events.length);
      for(const event of frame.events) {
        assert.equal(event.seq,cursor++);
        summary.event_bytes+=Buffer.byteLength(encode(event));
        if(event.type==='compaction/end') summary.compactions++;
      }
      summary.events=cursor;
      const paramsHash=hash(encode(frame.params));
      const isSummary=frame.method==='model' && frame.params.messages.some(m=>m.content.includes('Create a concise continuity checkpoint.'));
      if(frame.method==='model') {
        if(isSummary) summary.summaries++; else summary.models++;
        summary.max_model_json_bytes=Math.max(summary.max_model_json_bytes,Buffer.byteLength(encode(frame.params)));
      }
      if(frame.method==='tool') summary.tools++;
      let result;
      if(replay) {
        const next=await iterator.next(); assert.equal(next.done,false,'unexpected replay journal end');
        const row=JSON.parse(next.value),{hash:expected,...record}=row;
        assert.equal(expected,hash(chain+'\n'+encode(record)),'journal hash chain mismatch');
        chain=expected;
        assert.equal(record.id,frame.id); assert.equal(record.method,frame.method);
        assert.equal(record.params_sha256,paramsHash,'replay changed semantic model/tool/state input');
        // Event times/identities are reconstructed, not reused as canonical archive.
        assert.equal(record.events.length,frame.events.length,'replay changed event batch length');
        assert.deepEqual(record.events.map(e=>e.type),frame.events.map(e=>e.type));
        result=record.result;
      } else if(frame.method==='checkpoint') {
        result={persisted:true,manifest_hash:hash(chain+'\n'+encode(frame.events))};
      } else if(frame.method==='working_state_read') {
        result={operation_id:`${runID}/working-state/${frame.id}`,view:{run_id:runID,revision:1,rule_revision:1,
          source_rule_revision:1,stale:false,task,constraints:['Synthetic only; observations and plans are separate.'],
          state:{format:1,phase:'fixed working set',questions:[],conflicts:[],
            observations:[{id:'kept',kind:'observation',text:'17 synthetic units on 2026-10-01',receipts:[`${runID}/dsh/fixture-1`]}],next_steps:[]}}};
      } else if(frame.method==='model') {
        if(isSummary) result={role:'assistant',content:'Synthetic continuity checkpoint; continue reading. This summary intentionally omits the quantity and date.'};
        else {
          const text=encode(frame.params.messages);
          assert.ok(text.includes('17 synthetic units on 2026-10-01'),'working state lost after compaction');
          if(summary.models<=count) {
            previousIndex=summary.models;
            result={role:'assistant',content:'',tool_calls:[{id:`call-${previousIndex}`,type:'function',
              function:{name:'evidence_read',arguments:encode({index:previousIndex})}}]};
          } else result={role:'assistant',content:'17 synthetic units on 2026-10-01. No market conclusion.'};
        }
      } else if(frame.method==='tool') {
        assert.equal(frame.params.name,'evidence_read');
        assert.equal(frame.params.arguments.index,previousIndex);
        assert.equal(frame.params.arguments.index,++toolIndex);
        const block=hash(`synthetic-record-${previousIndex}`);
        result=encode({text:`SYNTHETIC ${previousIndex}: 17 actual units; plan 20. `+block.repeat(64).slice(0,payloadBytes),
          receipt:{operation_id:`${runID}/dsh/${frame.id}`,committed:true}});
      } else if(frame.method==='finish') result={done:true};
      else throw new Error(`unexpected frame ${frame.method}`);
      if(!replay) {
        const record={id:frame.id,method:frame.method,params_sha256:paramsHash,events:frame.events,result};
        chain=hash(chain+'\n'+encode(record));
        fs.writeSync(journal,encode({...record,hash:chain})+'\n');
        // Acknowledge only after the test transcript is flushed to the OS/device.
        // This is not the production Runtime's transaction or artifact protocol.
        fs.fsyncSync(journal);
      }
      if(frame.method==='finish') finished=true;
      child.stdin.write(encode({id:frame.id,result})+'\n');
    }
    const status=await exit; summary.exit=status;
    assert.deepEqual(status,{code:0,signal:null}); assert.equal(finished,true);
    assert.equal(summary.tools,count); assert.equal(summary.models,count+1);
    assert.ok(summary.compactions>0 && summary.summaries>0);
    if(iterator) assert.equal((await iterator.next()).done,true,'unused journal suffix');
    summary.journal_chain_sha256=chain;
    summary.journal_bytes=fs.statSync(journalPath).size;
    summary.completed=true;
  } catch(error) {
    summary.error=error.stack || String(error); child.kill(); summary.exit=await exit;
  } finally {
    clearTimeout(timer); replayLines?.close(); replayStream?.destroy();
    summary.elapsed_ms=performance.now()-started;
    if(journal!==null) fs.closeSync(journal);
    fs.closeSync(metrics); fs.closeSync(stderrFile);
    fs.writeFileSync(path.join(out,`${label}-result.json`),encode(summary)+'\n');
  }
  console.log(encode({label,completed:summary.completed,events:summary.events,event_bytes:summary.event_bytes,
    compactions:summary.compactions,elapsed_ms:Math.round(summary.elapsed_ms),
    first_heap:summary.samples[0]?.heapUsed,last_heap:summary.samples.at(-1)?.heapUsed}));
  return summary;
}

const report={format:1,kind:'source-dsh-memory-characterization',passed:false,
  production_acceptance:false,provider_calls:0,engine:manifest.source_engine,node:process.version,
  source_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  platform:process.platform,arch:process.arch,kernel_sha256:manifest.kernel_sha256,
  runner_sha256:manifest.source_runner_sha256,heap_limit_mib:192,
  payload_bytes:payloadBytes,context_tokens:8192,sample_stride:stride,forced_gc:true,
  script_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  child_script_sha256:hash(fs.readFileSync(childFile)),runs:[]};
try {
  for(const count of steps) {
    const record=await execute(count,false); report.runs.push(record);
    assert.equal(record.completed,true,'record workload failed; inspect retained evidence');
    const replay=await execute(count,true); report.runs.push(replay);
    assert.equal(replay.completed,true,'fresh-process replay failed; inspect retained evidence');
    assert.equal(replay.journal_chain_sha256,record.journal_chain_sha256);
  }
  report.passed=true;
} catch(error) {report.error=error.stack || String(error);process.exitCode=1;}
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
