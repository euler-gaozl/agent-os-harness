import fs from 'node:fs';
import path from 'node:path';
import {residentHistory} from './resident-history.mjs';

// Compose a native-only capacity change AFTER the frozen resident-v2 transforms.
// Keeping the original transform untouched preserves all v1/v2/v3 builds.
export function nativeResidentCapacity(root,sha256) {
  const base=residentHistory(root,sha256),extra=[];
  const targets=new Set([
    'upstream/packages/core/session/src/tool-history.ts',
    'upstream/packages/llm/token-meter/src/index.ts',
    'upstream/packages/session/session-projection/src/index.ts',
  ]);
  return {get records(){return [...base.records,...extra.toSorted((a,b)=>a.target.localeCompare(b.target))]},plugin:{name:'native-resident-capacity-v4',setup(build){
    base.plugin.setup({...build,onLoad(options,callback){
      build.onLoad(options,args=>{
        const result=callback(args);
        const target=path.relative(root,args.path).replaceAll('\\','/');
        if(!targets.has(target))return result;
        const original=result?.contents;
        if(typeof original!=='string'||original.split('(8 << 20)').length!==2)
          throw new Error('native resident capacity transform mismatch');
        const contents=original.replace('(8 << 20)','(64 << 20)');
        extra.push({id:'native-resident-capacity-v4',target,transform_sha256:sha256(fs.readFileSync(new URL(import.meta.url))),
          original_sha256:sha256(original),transformed_sha256:sha256(contents)});
        return {...result,contents};
      });
    }});
  }}};
}
