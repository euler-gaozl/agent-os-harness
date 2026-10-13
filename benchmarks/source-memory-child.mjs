// Test-only observer. The deployed runner and kernel are imported unchanged.
// Samples are sent over a separate IPC channel, never added to bridge frames.
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';

if (!global.gc || !process.send) throw new Error('memory probe requires --expose-gc and IPC');
const stride = Number(process.argv[2]);
if (!Number.isSafeInteger(stride) || stride < 1) throw new Error('invalid sample stride');
const started = performance.now();
const write = process.stdout.write.bind(process.stdout);
let models = 0;
process.stdout.write = function (chunk, ...args) {
  // Source runner writes exactly one complete JSON frame per stdout write.
  const frame = JSON.parse(String(chunk));
  const normal = frame.method === 'model' && !frame.params.messages.some(message =>
    message.content.includes('Create a concise continuity checkpoint.'));
  if (normal) models++;
  if ((normal && (models === 1 || models % stride === 0)) || frame.method === 'finish') {
    // Deliberately measures retained heap after GC, not allocation throughput.
    // Includes the live request and its serialized line at this bridge boundary.
    global.gc();
    process.send({kind:'memory-sample', frame:frame.id, method:frame.method,
      models, elapsed_ms:performance.now()-started, ...process.memoryUsage(),
      max_rss_kib:process.resourceUsage().maxRSS});
  }
  return write(chunk, ...args);
};
await import(process.argv[3] ? pathToFileURL(process.argv[3]).href : '../source-runner.mjs');
