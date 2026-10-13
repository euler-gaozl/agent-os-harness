import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

test('source DSH drives model, tool and final receipt through the platform bridge', {timeout: 15000}, async t => {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, ['--max-old-space-size=192', fileURLToPath(new URL('../runner.mjs', import.meta.url))], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({error}));
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  t.after(async () => { child.kill(); await exited; });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-32768); });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  send({type: 'init', run_id: 'source-kernel-fixture', model: 'controlled-fixture', context_tokens: 8192,
    evidence_protocol: 1, system: 'Read the original controlled source before responding.', task: 'Verify SOURCE-417 inventory.',
    tools: [{name: 'evidence_read', description: 'Read a controlled fixture.', inputSchema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id'], additionalProperties: false}}],
  });
  let cursor = 0, sequence = 0, models = 0, tools = 0, finished = false;
  const eventTypes = new Set();
  for await (const line of createInterface({input: child.stdout})) {
    const frame = JSON.parse(line);
    assert.equal(frame.id, ++sequence);
    assert.equal(frame.event_start, cursor);
    assert.equal(frame.event_end, cursor + frame.events.length);
    cursor = frame.event_end;
    for (const event of frame.events) eventTypes.add(event.type);
    if (frame.method === 'model') {
      models++;
      if (models === 1) {
        assert.equal(frame.params.tools[0].name, 'evidence_read');
        send({id: frame.id, result: {role: 'assistant', content: '', tool_calls: [{id: 'fixture-call', type: 'function', function: {name: 'evidence_read', arguments: '{"id":"SOURCE-417"}'}}]}});
      } else {
        assert.equal(models, 2);
        assert.ok(frame.params.messages.some(m => m.role === 'tool' && m.content.includes('17 actual units')));
        send({id: frame.id, result: {role: 'assistant', content: 'SOURCE-417: 17 actual units; 20 is a future plan.'}});
      }
    } else if (frame.method === 'tool') {
      tools++;
      assert.equal(models, 1);
      assert.equal(frame.params.name, 'evidence_read');
      assert.deepEqual(frame.params.arguments, {id: 'SOURCE-417'});
      send({id: frame.id, result: 'SOURCE-417: 17 actual units; future plan 20 units. Synthetic acceptance data.'});
    } else if (frame.method === 'finish') {
      assert.equal(models, 2);
      assert.equal(tools, 1);
      assert.match(frame.params.result, /SOURCE-417: 17 actual units/);
      finished = true;
      send({id: frame.id, result: {done: true}});
    } else {
      assert.fail(`Unexpected source runner method: ${frame.method}`);
    }
  }
  const exit = await exited;
  assert.deepEqual(exit, {code: 0, signal: null}, stderr);
  assert.equal(finished, true);
  assert.ok(cursor > 0);
  assert.ok(eventTypes.has('turn/end'));
  assert.ok(eventTypes.has('assistant/message'));
});
