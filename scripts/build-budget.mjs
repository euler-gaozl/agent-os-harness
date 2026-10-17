import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {root,sha256,verifyUpstream} from './verify-upstream.mjs';
import {inlinePackageVersion} from '../patches/inline-package-version.mjs';
import {residentHistory} from '../patches/resident-history.mjs';

if(process.versions.node.split('.')[0]!=='24')throw new Error('Node 24 required');
const lock=verifyUpstream(),version=inlinePackageVersion(root,sha256),resident=residentHistory(root,sha256);
const out=path.join(root,'.work/budget-candidate');
const built=await esbuild.build({absWorkingDir:root,entryPoints:['src/budget-kernel.ts'],
  tsconfig:'upstream/tsconfig.base.json',bundle:true,platform:'node',format:'esm',target:'node24',
  keepNames:true,metafile:true,write:false,outfile:'.work/budget-candidate/dist/kernel.mjs',
  plugins:[version.plugin,resident.plugin]});
const inputs={};
for(const file of Object.keys(built.metafile.inputs).sort()){
  const absolute=path.resolve(root,file),relative=path.relative(root,absolute).replaceAll('\\','/');
  if(relative.startsWith('../')||path.isAbsolute(relative))throw new Error('input outside repository');
  if(!relative.startsWith('upstream/')&&!['src/kernel.ts','src/source-platform.ts','src/resident-kernel.ts',
    'src/resident-platform.ts','src/resident-log.ts','src/resident-profile.ts','src/budget-kernel.ts','src/budget-protocol.ts'].includes(relative)&&!relative.startsWith('node_modules/'))
    throw new Error(`unexpected input ${relative}`);
  if(relative.startsWith('node_modules/')&&!relative.includes('/zod/'))throw new Error('unexpected dependency');
  inputs[relative]=sha256(fs.readFileSync(absolute));
}
for(const output of Object.values(built.metafile.outputs))for(const dependency of output.imports)
  if(!dependency.external||!dependency.path.startsWith('node:'))throw new Error('unexpected external import');
if(built.outputFiles.length!==1)throw new Error('unexpected build output');
const notices=[fs.readFileSync(path.join(root,'upstream/LICENSE'),'utf8')];
for(const pkg of lock.packages){const file=path.join(root,'upstream',pkg.path,'LICENSE');if(fs.existsSync(file))notices.push(pkg.name,fs.readFileSync(file,'utf8'))}
notices.push('zod 4.6.5',fs.readFileSync(path.join(root,'node_modules/zod/LICENSE'),'utf8'));
const noticeText=notices.join('\n\n')+'\n',body=built.outputFiles[0].contents;
const manifest={format:1,candidate_only:true,source_engine:'dsh-source-687f282e-budget-v3',model_receipt_protocol:1,
  upstream_commit:lock.commit,upstream_lock_sha256:sha256(fs.readFileSync(path.join(root,'upstream-lock.json'))),
  dependency_lock_sha256:sha256(fs.readFileSync(path.join(root,'pnpm-lock.yaml'))),
  esbuild:esbuild.version,target:'node24',kernel_sha256:sha256(body),kernel_bytes:body.length,
  source_runner_sha256:sha256(fs.readFileSync(path.join(root,'budget-runner.mjs'))),
  notices_sha256:sha256(noticeText),patches:[version.record,...resident.records],inputs,
  build_script_sha256:sha256(fs.readFileSync(new URL(import.meta.url)))};
fs.mkdirSync(path.join(out,'dist'),{recursive:true});
fs.writeFileSync(path.join(out,'dist/kernel.mjs'),body);
fs.writeFileSync(path.join(out,'dist/THIRD_PARTY_NOTICES.txt'),noticeText);
fs.copyFileSync(path.join(root,'budget-runner.mjs'),path.join(out,'source-runner.mjs'));
fs.writeFileSync(path.join(out,'dist/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({out,engine:manifest.source_engine,kernel_sha256:manifest.kernel_sha256,patches:resident.records.length}));
