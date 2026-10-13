import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function exerciseRunner(t, runner) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, ['--no-global-search-paths', '--max-old-space-size=192', runner], {
    cwd: path.dirname(runner), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
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
}

test('source DSH drives model, tool and final receipt through the platform bridge', {timeout: 15000}, async t => {
  await exerciseRunner(t, fileURLToPath(new URL('../runner.mjs', import.meta.url)));
});

test('relocated runtime needs neither source nor package manifests nor node_modules', {timeout: 15000}, async t => {
  const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  const scratch = process.env.HARNESS_TEST_ARTIFACT_ROOT || os.tmpdir();
  fs.mkdirSync(scratch, {recursive: true});
  const base = fs.realpathSync(scratch);
  const relative = path.relative(root, base);
  assert.ok(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
    'Artifact scratch directory must be outside the source checkout');
  for (let ancestor = base; ; ancestor = path.dirname(ancestor)) {
    for (const name of ['node_modules', 'package.json']) {
      assert.equal(fs.existsSync(path.join(ancestor, name)), false,
        `Artifact lookup ancestor contains ${name}: ${ancestor}`);
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  const artifact = fs.mkdtempSync(path.join(base, 'runtime-'));
  t.after(() => {
    if (path.dirname(fs.realpathSync(artifact)) !== base) throw new Error('Scratch cleanup escaped its root');
    fs.rmSync(artifact, {recursive: true});
  });
  fs.mkdirSync(path.join(artifact, 'dist'));
  for (const file of ['kernel.mjs', 'manifest.json', 'THIRD_PARTY_NOTICES.txt']) {
    fs.copyFileSync(path.join(root, 'dist', file), path.join(artifact, 'dist', file));
  }
  fs.copyFileSync(path.join(root, 'runner.mjs'), path.join(artifact, 'runner.mjs'));
  assert.deepEqual(fs.readdirSync(artifact).sort(), ['dist', 'runner.mjs']);
  t.diagnostic('Runtime copied outside checkout; dependency-free lookup ancestors, artifact cwd and disabled global module search');
  await exerciseRunner(t, path.join(artifact, 'runner.mjs'));
});
