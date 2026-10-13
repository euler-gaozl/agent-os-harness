import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context,Session,Projection,TokenMeter,SourcePersistence,createUserMessage,ResidentEventLog}
  from '../../.work/resident-candidate/dist/kernel.mjs';

const ack={persisted:true,manifest_hash:'a'.repeat(64)};
async function setup(t,exchange=async()=>ack,limit) {
  const ctx=new Context();
  const mounted=[];
  for(const plugin of [Session,Projection,TokenMeter]) mounted.push(await ctx.plugin(plugin,{}));
  const persistence=new SourcePersistence(ctx,'resident-test',exchange,limit);
  const session=ctx.sessions.create('resident-test');
  t.after(()=>ctx.fiber.dispose());
  return {ctx,session,persistence,mounted,flush:()=>ctx.sessions.flush(session)};
}
function append(session,text,old) {
  return session.append('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}),
    old===undefined ? {surfaceOp:'append'} : {surfaceOp:{op:'replace',startSeq:old.seq,endSeq:old.seq},sourceEventSeqs:[old.seq]});
}

test('resident release uses acknowledged batch, preserves concurrent suffix and absolute sequence',async t=>{
  let release,entered;
  const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
  let calls=0;
  const {session,persistence,flush}=await setup(t,async()=>{if(++calls===1){entered();await gate;}return ack;});
  const first=append(session,'original evidence');
  const savedSnapshot=session.snapshotEvents();
  const pending=flush(); await started;
  const replacement=append(session,'summary',first);
  assert.equal(session.residentStats().evicted,0);
  release(); await pending;
  assert.equal(session.seq,2);
  assert.equal(session.residentStats().acknowledged,1);
  assert.equal(session.residentStats().evicted,1);
  assert.equal(persistence.stats().pendingEvents,1);
  assert.equal(session.eventAt(replacement.seq).data.content[0].text,'summary');
  assert.throws(()=>session.eventAt(first.seq),/archived/);
  assert.throws(()=>session.snapshotEvents(),/archived/);
  assert.equal(savedSnapshot[0].data.content[0].text,'original evidence','borrowed pre-eviction snapshots stay immutable');
  await flush();
  assert.equal(session.residentStats().acknowledged,2);
  assert.equal(append(session,'continued').seq,2);
  await flush();
});

test('invalid archive acknowledgement retains history and blocks all later effects',async t=>{
  let calls=0;
  const {session,persistence,flush}=await setup(t,async()=>{calls++;return {persisted:true,manifest_hash:'bad'};});
  const first=append(session,'unconfirmed'); append(session,'replacement',first);
  await assert.rejects(flush(),/checkpoint acknowledgement/);
  assert.equal(session.residentStats().evicted,0);
  assert.equal(session.snapshotEvents().length,2);
  await assert.rejects(persistence.request('tool',{}),/checkpoint acknowledgement/);
  assert.equal(calls,1);
});

test('surface can retain earliest system prompt and distant replacements without a dense prefix',async t=>{
  const {session,flush}=await setup(t);
  const system=session.append('system/message',{turn:1,step:1,message:{id:'system-fixture',role:'system',content:[{type:'text',text:'fixed instructions'}]}},{surfaceOp:'append'});
  let tail=append(session,'initial');
  for(let n=0;n<100;n++){tail=append(session,'latest '+n,tail);await flush();}
  assert.deepEqual(session.surface.nodes,[system.seq,tail.seq]);
  assert.equal(session.residentStats().residentEvents,2);
  assert.equal(session.seq,102);
  assert.equal(session.deriveMessages()[0].content[0].text,'fixed instructions');
  assert.throws(()=>session.releaseArchived(0),/watermark/);
});

test('consumer registration change after first archive barrier blocks later effects',async t=>{
  const {ctx,session,persistence,flush}=await setup(t);
  append(session,'fixture'); await flush();
  assert.throws(()=>ctx.sessionProjections.register({key:'late',stateVersion:1}),/late projection/);
  ctx.tokenMeter.retentionIdentity=Symbol('replaced-service-fixture');
  await assert.rejects(flush(),/consumer lifecycle/);
  await assert.rejects(persistence.request('model',{}),/consumer lifecycle/);
});

test('irreducible resident budget failure is sticky, before event admission',()=>{
  const log=new ResidentEventLog(1024,2);
  log.push({seq:0,type:'fixture',data:{value:'a'}});
  log.push({seq:1,type:'fixture',data:{value:'b'}});
  assert.throws(()=>log.push({seq:2,type:'fixture',data:{value:'c'}}),/budget/);
  assert.equal(log.length,2);
  assert.throws(()=>log.release(2,new Set()),/budget/);
  assert.throws(()=>log.push({seq:2,type:'fixture',data:{}}),/budget/);
});

test('unknown and same-name forged projections are rejected before the first exchange',async t=>{
  let effects=0;
  const {ctx,session}=await setup(t,async()=>{effects++;return ack;});
  for(const key of ['unknown','tokenUsage']) {
    assert.throws(()=>ctx.sessionProjections.register({key,stateVersion:2,
      init:()=>new Map(),apply:(state,event)=>state.set(event.seq,event)}),/unsupported resident projection/);
  }
  assert.equal(effects,0);
  assert.equal(session.residentStats().evicted,0);
});

test('lost checkpoint response cannot release unconfirmed history or pass another effect',async t=>{
  let effects=0;
  const {session,persistence,flush}=await setup(t,async()=>{effects++;throw new Error('fixture response lost after commit');});
  const first=append(session,'original');append(session,'replacement',first);
  await assert.rejects(flush(),/response lost/);
  assert.equal(session.residentStats().evicted,0);
  await assert.rejects(persistence.request('tool',{}),/response lost/);
  assert.equal(effects,1);
});

test('buffer overflow while awaiting checkpoint keeps unconfirmed suffix and blocks effects',async t=>{
  let release,entered,effects=0;
  const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
  const {session,persistence,flush}=await setup(t,async()=>{effects++;entered();await gate;return ack;},1024);
  append(session,'pending');
  const pending=flush();await started;
  const late=append(session,'late '.repeat(400));
  release();await assert.rejects(pending,/buffer budget/);
  assert.equal(session.eventAt(late.seq).data.content[0].text,'late '.repeat(400));
  assert.equal(session.residentStats().acknowledged,0);
  assert.equal(session.residentStats().evicted,0);
  await assert.rejects(persistence.request('model',{}),/buffer budget/);
  assert.equal(effects,1);
});

test('message projection plugin refuses release and is not hidden by event observer containment',async t=>{
  const {ctx,session,persistence,flush}=await setup(t);
  append(session,'fixture');
  ctx.sessions.registerMessageProjection({type:'fixture/unsupported',project:()=>new Map()});
  await assert.rejects(flush(),/fixed text-only/);
  assert.equal(session.residentStats().evicted,0);
  await assert.rejects(persistence.request('tool',{}),/fixed text-only/);
});

test('unloading a registered consumer blocks the next checkpoint and tool effect',async t=>{
  const {session,persistence,mounted,flush}=await setup(t);
  append(session,'fixture');await flush();
  await mounted[2].dispose();
  await assert.rejects(flush(),/consumer lifecycle/);
  await assert.rejects(persistence.request('tool',{}),/consumer lifecycle/);
});

test('live tool additions pin historical headers until their surface references disappear',async t=>{
  const {session,flush}=await setup(t);
  const schema=name=>({name,description:'fixture '+name,parameters:{type:'object'}});
  const header=(names,series=true)=>session.append('request/header',{
    header:{config:{provider:'fixture',model:'fixed'},tools:names.map(schema)},
    reason:series?'series':'tools',startsSeries:series});
  let nextMessage=0;
  const update=(kind,name,source)=>session.append('developer/message',{turn:1,step:1,
    ...(source===undefined?{}:{headerSeq:source.seq}),
    message:{id:'update-'+(++nextMessage),role:'developer',content:[{type:kind,toolName:name}]}},{surfaceOp:'append'});
  const first=header(['tool_a']);
  const addA=update('tool-addition','tool_a',first);
  await flush();
  const second=header(['tool_b']);
  update('tool-addition','tool_b',second);
  await flush();
  assert.equal(session.eventAt(first.seq).type,'request/header');
  assert.deepEqual(session.toolHistory().tools.map(t=>t.name),['tool_b']);
  append(session,'earlier update summarized',addA);
  await flush();
  assert.throws(()=>session.eventAt(first.seq),/archived/);
  const third=header(['tool_a','tool_b'],false);
  update('tool-addition','tool_a',third);
  const fourth=header(['tool_a'],false);
  update('tool-removal','tool_b');
  const before=JSON.stringify(session.toolHistory());
  await flush();
  assert.equal(JSON.stringify(session.toolHistory()),before,'release changed historical declaration/update semantics');
  assert.equal(session.requestHeader().tools[0].name,'tool_a');
  const fifth=header(['tool_a']);
  await flush();
  assert.deepEqual(session.toolHistory().updates,[],'new declaration series must reset update history');
  assert.equal(session.eventAt(fifth.seq).type,'request/header');
  assert.throws(()=>session.eventAt(fourth.seq),/archived/);
});

test('compaction control fold keeps boundary facts after the original events leave residency',()=>{
  const log=new ResidentEventLog();
  log.push({seq:0,type:'session/end-seed',data:{}});
  log.push({seq:1,type:'turn/start',data:{turn:7}});
  log.push({seq:2,type:'compaction/start',data:{kind:'fixture'}});
  log.release(3,new Set());
  assert.equal(log.compactionEntryState().openTurn,7);
  assert.equal(log.compactionEntryState().latestEndSeedSeq,0);
  assert.equal(log.compactionEntryState().unmatchedCompactionStart.seq,2);
  log.push({seq:3,type:'compaction/end',data:{}});
  log.push({seq:4,type:'turn/end',data:{}});
  log.release(5,new Set());
  assert.deepEqual(log.compactionEntryState(),{openTurn:null,unmatchedCompactionStart:undefined,latestEndSeedSeq:0});
});
