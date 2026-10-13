import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';

const [baseline,candidate,steps]=process.argv.slice(2);
assert.ok(baseline&&candidate&&/^\d+$/.test(steps),'baseline directory, candidate directory, steps required');
const report={kind:'fixture-cross-engine-semantic-comparison',steps:Number(steps),passed:false,frames:0};
const open=directory=>createInterface({input:fs.createReadStream(path.join(directory,`${steps}-journal.ndjson`)),crlfDelay:Infinity});
const left=open(baseline),right=open(candidate),next=right[Symbol.asyncIterator]();
try {
  for await(const line of left) {
    const other=await next.next(); assert.equal(other.done,false);
    const a=JSON.parse(line),b=JSON.parse(other.value);
    assert.equal(a.id,b.id); assert.equal(a.method,b.method);
    assert.equal(a.params_sha256,b.params_sha256,`semantic request changed at ${a.id}/${a.method}`);
    assert.deepEqual(a.events.map(e=>[e.seq,e.type]),b.events.map(e=>[e.seq,e.type]));
    // Archive acknowledgement hashes include original regenerated event IDs and
    // times, so they legitimately differ. All other frozen fixture replies match.
    if(a.method!=='checkpoint') assert.deepEqual(a.result,b.result);
    report.frames++;
  }
  assert.equal((await next.next()).done,true);
  report.passed=true;
} catch(error) {report.error=error.stack||String(error);process.exitCode=1;}
finally {left.close();right.close();}
const file=path.join(candidate,`${steps}-cross-engine.json`);
fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
