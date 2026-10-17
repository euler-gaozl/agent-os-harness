import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileToolGuards,validateToolArguments,WorkingStateTool,FinalOutputTool} from '../../.work/guarded-candidate/dist/kernel.mjs';
const schema={type:'object',properties:{id:{type:'string',minLength:1},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:1200}},required:['id'],additionalProperties:false};
const create=inputSchema=>compileToolGuards([{name:'read',inputSchema}]);

test('real paging limits reject before dispatch without modifying arguments',()=>{
  const guards=create(schema);
  for(const args of [{id:'doc',limit:2400},{id:'doc',limit:1600},{id:'doc',limit:0},{id:'doc',offset:-1},{id:'doc',limit:'12'},{id:'doc',limit:1.5},{id:''},{id:'doc',extra:true}]){
    const before=JSON.stringify(args);assert.throws(()=>validateToolArguments(guards,'read',args),/INVALID_TOOL_ARGUMENTS/);assert.equal(JSON.stringify(args),before);
  }
  for(const args of [{id:'doc'},{id:'doc',offset:0,limit:1200}])assert.doesNotThrow(()=>validateToolArguments(guards,'read',args));
});
test('nested and Unicode schema constraints use full JSON Schema semantics',()=>{
  const guards=create({type:'object',properties:{x:{type:'array',minItems:1,maxItems:2,uniqueItems:true,items:{$ref:'#/$defs/value'}}},required:['x'],additionalProperties:false,$defs:{value:{type:'string',minLength:1,maxLength:1,pattern:'^[🙂a]$'}}});
  validateToolArguments(guards,'read',{x:['🙂','a']});
  for(const x of [[],['a','a'],['a','🙂','a'],['ab'],['b']])assert.throws(()=>validateToolArguments(guards,'read',{x}),/INVALID_TOOL_ARGUMENTS/);
});
test('unsupported schemas reject at initialization instead of silently weakening validation',()=>{
  for(const input of [{type:'object',unknownConstraint:1},{$ref:'https://unconfigured.invalid/schema'},{$schema:'https://unsupported.invalid/schema'},{$async:true,type:'object'},{type:'string',format:'made-up'}])assert.throws(()=>create(input),/unsupported frozen tool input schema/);
  assert.throws(()=>compileToolGuards([{name:'same',inputSchema:{}},{name:'same',inputSchema:{}}]),/duplicate/);
});
test('declared dialects and formats are enforced without fetching or coercion',()=>{
  const draft7=create({$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{date:{type:'string',format:'date'}},required:['date']});
  validateToolArguments(draft7,'read',{date:'2026-10-17'});
  assert.throws(()=>validateToolArguments(draft7,'read',{date:'2026-02-30'}),/INVALID_TOOL_ARGUMENTS/);
  const guards=compileToolGuards([WorkingStateTool,FinalOutputTool]);
  assert.throws(()=>validateToolArguments(guards,'final_output_commit',{operation_id:'r/dsh/3',sha256:'wrong'}),/INVALID_TOOL_ARGUMENTS/);
});
