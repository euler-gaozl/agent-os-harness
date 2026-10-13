import fs from 'node:fs';
import path from 'node:path';

// Single-file packaging transform. The upstream file stays byte-for-byte
// unchanged; the manifest records both original and transformed inputs.
export function inlinePackageVersion(root, sha256) {
  const target = 'upstream/packages/llm/llm/src/attribution.ts';
  const metadata = 'upstream/packages/llm/llm/package.json';
  const original = fs.readFileSync(path.join(root, target), 'utf8');
  const packageBytes = fs.readFileSync(path.join(root, metadata));
  const pkg = JSON.parse(packageBytes);
  if (pkg.name !== '@deepseek-ai/dsh-llm' || typeof pkg.version !== 'string') throw new Error('Unexpected LLM metadata');
  const importLine = "import { createRequire } from 'node:module'";
  const versionLine = "const { version } = createRequire(import.meta.url)('../package.json') as { version: string }";
  if (original.split(importLine).length !== 2 || original.split(versionLine).length !== 2) {
    throw new Error('LLM metadata transform no longer matches the source baseline');
  }
  const contents = original.replace(importLine, '').replace(versionLine, `const version = ${JSON.stringify(pkg.version)}`);
  return {
    record: {id: 'inline-llm-package-version', target, metadata,
      transform_sha256: sha256(fs.readFileSync(new URL(import.meta.url))),
      original_sha256: sha256(original), metadata_sha256: sha256(packageBytes), transformed_sha256: sha256(contents)},
    plugin: {
      name: 'inline-locked-llm-metadata',
      setup(build) {
        build.onLoad({filter: /[/\\]llm[/\\]llm[/\\]src[/\\]attribution\.ts$/}, args => {
          if (path.resolve(args.path) !== path.resolve(root, target)) throw new Error('Unexpected LLM attribution input');
          return {contents, loader: 'ts', resolveDir: path.dirname(args.path)};
        });
      },
    },
  };
}
