import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {root, sha256, verifyUpstream} from './verify-upstream.mjs';
import {inlinePackageVersion} from '../patches/inline-package-version.mjs';

if (process.versions.node.split('.')[0] !== '24') throw new Error('Node 24 is required');
const lock = verifyUpstream();
const versionPatch = inlinePackageVersion(root, sha256);
const built = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/kernel.ts'],
  tsconfig: 'upstream/tsconfig.base.json',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  keepNames: true,
  metafile: true,
  write: false,
  outfile: 'dist/kernel.mjs',
  plugins: [versionPatch.plugin],
});
const inputs = {};
for (const file of Object.keys(built.metafile.inputs).sort()) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Build input outside repository');
  if (!relative.startsWith('upstream/') && relative !== 'src/kernel.ts' && !relative.startsWith('node_modules/')) {
    throw new Error(`Unexpected kernel build input: ${relative}`);
  }
  if (relative.startsWith('node_modules/') && !relative.includes('/zod/')) throw new Error(`Unapproved kernel dependency: ${relative}`);
  inputs[relative] = sha256(fs.readFileSync(absolute));
}
for (const output of Object.values(built.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || !dependency.path.startsWith('node:')) throw new Error('Kernel must have only Node built-in external imports');
  }
}
if (built.outputFiles.length !== 1) throw new Error('Unexpected kernel build output');
const body = built.outputFiles[0].contents;
const licenses = ['DSH source baseline', fs.readFileSync(path.join(root, 'upstream/LICENSE'), 'utf8')];
for (const pkg of lock.packages) {
  const license = path.join(root, 'upstream', pkg.path, 'LICENSE');
  if (fs.existsSync(license)) licenses.push(pkg.name, fs.readFileSync(license, 'utf8'));
}
licenses.push('zod 4.6.5', fs.readFileSync(path.join(root, 'node_modules/zod/LICENSE'), 'utf8'));
const notices = licenses.join('\n\n') + '\n';
fs.mkdirSync(path.join(root, 'dist'), {recursive: true});
fs.writeFileSync(path.join(root, 'dist/kernel.mjs'), body);
fs.writeFileSync(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), notices);
const manifest = {
  format: 1,
  candidate_only: true,
  upstream_commit: lock.commit,
  upstream_lock_sha256: sha256(fs.readFileSync(path.join(root, 'upstream-lock.json'))),
  dependency_lock_sha256: sha256(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'))),
  esbuild: esbuild.version,
  target: 'node24',
  kernel_sha256: sha256(body),
  kernel_bytes: body.length,
  notices_sha256: sha256(notices),
  runner_sha256: sha256(fs.readFileSync(path.join(root, 'runner.mjs'))),
  patches: [versionPatch.record],
  inputs,
};
fs.writeFileSync(path.join(root, 'dist/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({inputs: Object.keys(inputs).length, kernel_bytes: body.length, kernel_sha256: manifest.kernel_sha256}));
