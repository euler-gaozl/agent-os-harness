import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

// Versioned v6 admission only. Historical runners keep their frozen behavior.
// No schema fetches, coercion, defaults, argument edits or exception recovery.
export function compileToolGuards(tools: any[]): Map<string, (args: unknown) => void> {
  const guards = new Map<string, (args: unknown) => void>();
  const options = {strict: true, strictTypes: false, strictTuples: false,
    allowUnionTypes: true, allErrors: false, ownProperties: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false,
    validateFormats: true, logger: false as const};
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || guards.has(tool.name)) {
      throw new Error('duplicate or invalid frozen tool name');
    }
    const schema = tool.inputSchema;
    let validate: any;
    try {
      // Separate instances prevent cross-tool $id references or dialect leakage.
      const dialect = schema?.$schema;
      const compiler = dialect === 'http://json-schema.org/draft-07/schema#' ||
        dialect === 'https://json-schema.org/draft-07/schema' ? new Ajv(options) :
        dialect === undefined || dialect === 'https://json-schema.org/draft/2020-12/schema' ?
          new Ajv2020(options) : null;
      if (!compiler) throw new Error('unsupported dialect');
      addFormats(compiler);
      validate = compiler.compile(schema);
      if (validate.$async) throw new Error('async schema forbidden');
    } catch {
      throw new Error(`unsupported frozen tool input schema: ${tool.name}`);
    }
    guards.set(tool.name, (args: unknown) => {
      if (validate(args)) return;
      // Never echo values. The model already has the authoritative schema.
      const issue = validate.errors?.[0];
      const location = String(issue?.instancePath ?? '/').slice(0, 240);
      const rule = String(issue?.keyword ?? 'schema').slice(0, 80);
      const explanation = String(issue?.message ?? 'does not match the declared schema').slice(0, 320);
      throw new Error(`INVALID_TOOL_ARGUMENTS: ${location || '/'} ${rule}: ${explanation}. Nothing was executed. Correct the arguments using the declared tool schema; do not retry unchanged arguments.`);
    });
  }
  return guards;
}

export function validateToolArguments(guards: Map<string, (args: unknown) => void>, name: string, args: unknown): void {
  const guard = guards.get(name);
  if (!guard) throw new Error('tool has no frozen argument validator');
  guard(args);
}
