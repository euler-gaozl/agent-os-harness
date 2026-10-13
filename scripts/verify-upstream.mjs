import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = body => createHash('sha256').update(body).digest('hex');

export function verifyUpstream() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'upstream-lock.json'), 'utf8'));
  const source = path.join(root, 'upstream');
  const found = [];
  const visit = relative => {
    for (const name of fs.readdirSync(path.join(source, relative)).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const file = path.join(source, rel);
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink()) throw new Error(`Upstream link forbidden: ${rel}`);
      if (info.isDirectory()) { visit(rel); continue; }
      const expected = lock.files[rel];
      if (!info.isFile() || !expected || info.size !== expected.bytes || sha256(fs.readFileSync(file)) !== expected.sha256) {
        throw new Error(`Upstream baseline mismatch: ${rel}`);
      }
      found.push(rel);
    }
  };
  visit('');
  if (found.length !== Object.keys(lock.files).length) throw new Error('Upstream baseline files missing');
  return lock;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = verifyUpstream();
  console.log(`Verified ${Object.keys(lock.files).length} files from ${lock.commit}`);
}
