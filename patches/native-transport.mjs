import fs from 'node:fs';
import path from 'node:path';

// Native-only capacity profile. The source module and all historical builds
// stay unchanged; original and transformed bytes are pinned in the manifest.
export function nativeTransport(root,sha256) {
  const files=new Map(),records=[];
  const profile=[['src/source-platform.ts',[
    ['const MAX_BATCH_BYTES = 16 << 20;','const MAX_BATCH_BYTES = 64 << 20;'],
    ['Buffer.byteLength(text) > (4 << 20) + 1024','Buffer.byteLength(text) > (16 << 20) + 1024'],
  ]],['src/resident-log.ts',[
    ['constructor(private maxBytes = 16 << 20,','constructor(private maxBytes = 64 << 20,'],
  ]]];
  for(const [target,replacements] of profile) {
    const file=path.resolve(root,target),original=fs.readFileSync(file,'utf8');
    let text=original;
    for(const [before,after] of replacements) {
      if(text.split(before).length!==2)throw new Error('native transport patch mismatch');
      text=text.replace(before,after);
    }
    files.set(file,text);
    records.push({id:'native-transport-v4',target,transform_sha256:sha256(fs.readFileSync(new URL(import.meta.url))),
      original_sha256:sha256(original),transformed_sha256:sha256(text)});
  }
  return {records,plugin:{name:'native-transport-v4',setup(build){
      build.onLoad({filter:/(source-platform|resident-log)\.ts$/},args=>{
        const contents=files.get(path.resolve(args.path));
        return contents===undefined?undefined:{contents,loader:'ts',resolveDir:path.dirname(args.path)};
      });
    }}};
}
