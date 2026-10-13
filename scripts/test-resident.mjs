import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {root} from './verify-upstream.mjs';

const result=spawnSync(process.execPath,['--test','--test-reporter=tap',
  'tests/resident/resident-history.test.mjs','tests/source-runner.test.mjs'],{
  cwd:root,windowsHide:true,stdio:'inherit',
  env:{...process.env,HARNESS_TEST_RUNTIME:path.join(root,'.work/resident-candidate')},
});
if(result.error)throw result.error;
process.exitCode=result.status ?? 1;
