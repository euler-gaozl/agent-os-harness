import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context,Session,SourcePersistence,createUserMessage,workingContext} from '../dist/kernel.mjs';

const ack = {persisted:true,manifest_hash:'a'.repeat(64)};
const append = (session,text) => session.append('user/message',{message:createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})},{surfaceOp:'append'});
async function setup(t,exchange,limit) {
  const ctx = new Context(); await ctx.plugin(Session,{});
  const persistence = new SourcePersistence(ctx,'fixture',exchange,limit);
  const session = ctx.sessions.create('fixture');
  t.after(async()=>{await ctx.fiber.dispose();});
  return {ctx,persistence,session};
}

test('incremental buffer holds events through ack and preserves events appended during flush', async t => {
  const frames=[]; let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const {ctx,persistence,session}=await setup(t,async frame=>{frames.push(frame); if(frames.length===1){entered();await gate;} return ack;});
  append(session,'first retained source');
  const flushed=ctx.sessions.flush(session); await started;
  append(session,'arrived while awaiting acknowledgement');
  assert.equal(persistence.stats().acknowledged,0);
  assert.equal(persistence.stats().pendingEvents,2);
  release(); await flushed;
  assert.equal(persistence.stats().acknowledged,1);
  assert.equal(persistence.stats().pendingEvents,1);
  // Barriers use the incremental feed, not snapshots of all previous events.
  session.snapshotEvents=()=>{throw new Error('unexpected full-history copy');};
  await ctx.sessions.flush(session);
  await ctx.sessions.flush(session);
  assert.deepEqual(frames.map(f=>[f.method,f.event_start,f.event_end]),[['checkpoint',0,1],['checkpoint',1,2],['checkpoint',2,2]]);
  assert.equal(persistence.stats().pendingBytes,2);
});

test('contained observer overflow is sticky and prevents all external exchanges', async t => {
  let calls=0;
  const {ctx,persistence,session}=await setup(t,async()=>{calls++;return ack;},512);
  // Upstream append succeeds; persistence failure must still stop the next effect.
  append(session,'too large '.repeat(200));
  assert.equal(persistence.stats().failed,true);
  assert.ok(persistence.stats().pendingBytes<=512);
  await assert.rejects(ctx.sessions.flush(session),/buffer budget/);
  await assert.rejects(persistence.request('model',{}),/buffer budget/);
  assert.equal(calls,0);
});

test('rejected or malformed checkpoint retains evidence and cannot be retried past the failed barrier', async t => {
  const {ctx,persistence,session}=await setup(t,async()=>({persisted:true,manifest_hash:'not a retained hash'}));
  append(session,'not yet acknowledged');
  await assert.rejects(ctx.sessions.flush(session),/checkpoint acknowledgement/);
  assert.equal(persistence.stats().pendingEvents,1);
  assert.equal(persistence.stats().acknowledged,0);
  await assert.rejects(persistence.request('tool',{}),/checkpoint acknowledgement/);
});

test('working context validates ownership and includes each frozen read identity', () => {
  const reply={operation_id:'run/working-state/2',view:{run_id:'run',revision:0,rule_revision:1,task:'literal {{not_a_template}}',constraints:[]}};
  const text=workingContext(reply,'run');
  assert.match(text,/literal \{\{not_a_template\}\}/);
  assert.notEqual(text,workingContext({...reply,operation_id:'run/working-state/4'},'run'));
  assert.throws(()=>workingContext(reply,'other'),/invalid frozen/);
  assert.throws(()=>workingContext({...reply,view:{...reply.view,task:'x'.repeat(5<<20)}},'run'),/transport budget/);
});
