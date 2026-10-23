import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ToolOutcome, ToolSpec } from '../types.ts';
import { ToolError, optionalNumber, relativePath, truncate } from './util.ts';

/** Guards against schemas that would pin the event loop with recursion. */
const MAX_SCHEMA_BYTES = 2_000_000;
const MAX_FILE_BYTES = 5_000_000;
const MAX_DEPTH = 64;
const MAX_REFS = 200;
const MAX_ERRORS_DEFAULT = 25;
const MAX_ERRORS_CAP = 100;
const MAX_ARRAY_CHECK = 2_000;

type JsonObject = Record<string, unknown>;

interface SchemaError {
  path: string;
  message: string;
  keyword: string;
}

/** One schema document plus where its relative `$ref`s resolve from. */
interface Scope {
  root: unknown;
  dir: string | null;
}

interface Context {
  errors: SchemaError[];
  maxErrors: number;
  depth: number;
  refs: number;
  ignored: Set<string>;
  cache: Map<string, unknown>;
  load: (absolute: string) => Promise<unknown>;
}

/** Keywords this validator understands; anything else is reported as ignored. */
const SUPPORTED = new Set([
  '$ref', '$defs', 'definitions', '$schema', '$id', '$comment',
  'type', 'enum', 'const',
  'properties', 'patternProperties', 'additionalProperties', 'propertyNames',
  'required', 'dependentRequired', 'minProperties', 'maxProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);

/** Annotation-only keywords: not validation rules, so never worth warning about. */
const ANNOTATIONS = new Set([
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'format',
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  if (expected === 'array') return Array.isArray(value);
  const target = expected === 'object' ? 'object' : expected;
  return actual === target;
}

/** Stable key order, so equal objects compare equal and uniqueItems is exact. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isObject(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function escape(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function child(path: string, segment: string | number): string {
  return `${path}/${escape(segment)}`;
}

function shownPath(path: string): string {
  return path === '' ? '#' : `#${path}`;
}

function fail(ctx: Context, path: string, message: string, keyword: string): void {
  if (ctx.errors.length >= ctx.maxErrors) return;
  ctx.errors.push({ path, message, keyword });
}

function pointer(root: unknown, fragment: string, ref: string): unknown {
  if (fragment === '' || fragment === '#') return root;
  if (!fragment.startsWith('#/')) throw new ToolError(`Unsupported $ref "${ref}": only JSON Pointer fragments are supported`);
  let current: unknown = root;
  for (const raw of fragment.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new ToolError(`$ref "${ref}" does not resolve`);
      }
      current = current[index];
    } else if (isObject(current) && Object.prototype.hasOwnProperty.call(current, key)) {
      current = current[key];
    } else {
      throw new ToolError(`$ref "${ref}" does not resolve`);
    }
  }
  return current;
}

async function resolveRef(ref: string, ctx: Context, scope: Scope): Promise<{ schema: unknown; scope: Scope }> {
  const hash = ref.indexOf('#');
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash);

  if (filePart === '') {
    return { schema: pointer(scope.root, fragment, ref), scope };
  }
  if (!scope.dir) throw new ToolError(`$ref "${ref}" is relative, but the schema was given inline`);

  const target = resolve(scope.dir, decodeURIComponent(filePart));
  let document = ctx.cache.get(target);
  if (document === undefined) {
    document = await ctx.load(target);
    ctx.cache.set(target, document);
  }
  return { schema: pointer(document, fragment, ref), scope: { root: document, dir: dirname(target) } };
}

/** Runs a branch without recording its errors, for anyOf/oneOf/not/if. */
async function matches(value: unknown, schema: unknown, path: string, ctx: Context, scope: Scope): Promise<boolean> {
  const inner: Context = {
    errors: [],
    maxErrors: ctx.maxErrors,
    depth: ctx.depth,
    refs: ctx.refs,
    ignored: ctx.ignored,
    cache: ctx.cache,
    load: ctx.load,
  };
  await validate(value, schema, path, inner, scope);
  ctx.refs = Math.max(ctx.refs, inner.refs);
  return inner.errors.length === 0;
}

async function validate(value: unknown, schema: unknown, path: string, ctx: Context, scope: Scope): Promise<void> {
  if (ctx.errors.length >= ctx.maxErrors) return;
  if (ctx.depth >= MAX_DEPTH) {
    fail(ctx, path, `schema nesting is deeper than ${MAX_DEPTH} levels`, '$ref');
    return;
  }
  if (schema === true) return;
  if (schema === false) {
    fail(ctx, path, 'no value is allowed here', 'false');
    return;
  }
  if (!isObject(schema)) {
    fail(ctx, path, 'schema is not an object or boolean', 'schema');
    return;
  }

  ctx.depth += 1;
  try {
    const s = schema;

    if (typeof s.$ref === 'string') {
      ctx.refs += 1;
      if (ctx.refs > MAX_REFS) {
        fail(ctx, path, `more than ${MAX_REFS} $refs were followed`, '$ref');
        return;
      }
      const resolved = await resolveRef(s.$ref, ctx, scope);
      // Draft 2020-12: $ref is an ordinary applicator, so the keywords written
      // beside it still apply. Validate the target, then fall through to them.
      await validate(value, resolved.schema, path, ctx, resolved.scope);
    }

    for (const key of Object.keys(s)) {
      if (SUPPORTED.has(key) || ANNOTATIONS.has(key) || key.startsWith('$')) continue;
      ctx.ignored.add(key);
    }

    if (s.type !== undefined) {
      const types = (Array.isArray(s.type) ? s.type : [s.type]).filter(
        (entry): entry is string => typeof entry === 'string',
      );
      if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
        fail(ctx, path, `expected ${types.join(' or ')}, got ${typeOf(value)}`, 'type');
        return;
      }
    }

    if ('const' in s && !equal(value, s.const)) {
      fail(ctx, path, `must equal ${JSON.stringify(s.const)}`, 'const');
    }
    if (Array.isArray(s.enum) && !s.enum.some((option) => equal(value, option))) {
      fail(ctx, path, `must be one of ${s.enum.map((option) => JSON.stringify(option)).join(', ')}`, 'enum');
    }

    if (isObject(value)) {
      const object = value;
      const properties = isObject(s.properties) ? s.properties : {};
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(object, key)) {
          await validate(object[key], sub, child(path, key), ctx, scope);
        }
      }

      if (Array.isArray(s.required)) {
        for (const key of s.required) {
          if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(object, key)) {
            fail(ctx, path, `missing required property "${key}"`, 'required');
          }
        }
      }

      const claimed = new Set(Object.keys(properties));
      if (isObject(s.patternProperties)) {
        for (const [pattern, sub] of Object.entries(s.patternProperties)) {
          let re: RegExp;
          try {
            re = new RegExp(pattern);
          } catch {
            fail(ctx, path, `patternProperties "${pattern}" is not a valid regular expression`, 'patternProperties');
            continue;
          }
          for (const key of Object.keys(object)) {
            if (!re.test(key)) continue;
            claimed.add(key);
            await validate(object[key], sub, child(path, key), ctx, scope);
          }
        }
      }

      if (s.additionalProperties !== undefined) {
        for (const key of Object.keys(object)) {
          if (claimed.has(key)) continue;
          if (s.additionalProperties === false) {
            fail(ctx, child(path, key), 'is not an allowed property', 'additionalProperties');
          } else if (s.additionalProperties !== true) {
            await validate(object[key], s.additionalProperties, child(path, key), ctx, scope);
          }
        }
      }

      if (s.propertyNames !== undefined) {
        for (const key of Object.keys(object)) {
          await validate(key, s.propertyNames, child(path, key), ctx, scope);
        }
      }

      if (isObject(s.dependentRequired)) {
        for (const [key, needs] of Object.entries(s.dependentRequired)) {
          if (!Object.prototype.hasOwnProperty.call(object, key) || !Array.isArray(needs)) continue;
          for (const need of needs) {
            if (typeof need === 'string' && !Object.prototype.hasOwnProperty.call(object, need)) {
              fail(ctx, path, `property "${key}" requires "${need}"`, 'dependentRequired');
            }
          }
        }
      }

      const count = Object.keys(object).length;
      if (typeof s.minProperties === 'number' && count < s.minProperties) {
        fail(ctx, path, `must have at least ${s.minProperties} properties`, 'minProperties');
      }
      if (typeof s.maxProperties === 'number' && count > s.maxProperties) {
        fail(ctx, path, `must have at most ${s.maxProperties} properties`, 'maxProperties');
      }
    }

    if (Array.isArray(value)) {
      const array = value;
      const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : null;
      if (prefix) {
        for (let index = 0; index < Math.min(array.length, prefix.length); index += 1) {
          await validate(array[index], prefix[index], child(path, index), ctx, scope);
        }
      }
      if (s.items !== undefined && !Array.isArray(s.items)) {
        const start = prefix ? prefix.length : 0;
        for (let index = start; index < array.length; index += 1) {
          await validate(array[index], s.items, child(path, index), ctx, scope);
        }
      }
      if (typeof s.minItems === 'number' && array.length < s.minItems) {
        fail(ctx, path, `must have at least ${s.minItems} items`, 'minItems');
      }
      if (typeof s.maxItems === 'number' && array.length > s.maxItems) {
        fail(ctx, path, `must have at most ${s.maxItems} items`, 'maxItems');
      }
      if (s.uniqueItems === true && array.length <= MAX_ARRAY_CHECK) {
        const seen = new Set<string>();
        for (let index = 0; index < array.length; index += 1) {
          const key = canonical(array[index]);
          if (seen.has(key)) fail(ctx, child(path, index), 'duplicates an earlier item', 'uniqueItems');
          seen.add(key);
        }
      }
    }

    if (typeof value === 'string') {
      const length = [...value].length;
      if (typeof s.minLength === 'number' && length < s.minLength) {
        fail(ctx, path, `must be at least ${s.minLength} characters`, 'minLength');
      }
      if (typeof s.maxLength === 'number' && length > s.maxLength) {
        fail(ctx, path, `must be at most ${s.maxLength} characters`, 'maxLength');
      }
      if (typeof s.pattern === 'string') {
        try {
          if (!new RegExp(s.pattern).test(value)) fail(ctx, path, `does not match /${s.pattern}/`, 'pattern');
        } catch {
          fail(ctx, path, `"pattern" is not a valid regular expression`, 'pattern');
        }
      }
    }

    if (typeof value === 'number') {
      if (typeof s.minimum === 'number' && value < s.minimum) {
        fail(ctx, path, `must be >= ${s.minimum}`, 'minimum');
      }
      if (typeof s.maximum === 'number' && value > s.maximum) {
        fail(ctx, path, `must be <= ${s.maximum}`, 'maximum');
      }
      if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) {
        fail(ctx, path, `must be > ${s.exclusiveMinimum}`, 'exclusiveMinimum');
      }
      if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) {
        fail(ctx, path, `must be < ${s.exclusiveMaximum}`, 'exclusiveMaximum');
      }
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
        const ratio = value / s.multipleOf;
        if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
          fail(ctx, path, `must be a multiple of ${s.multipleOf}`, 'multipleOf');
        }
      }
    }

    if (Array.isArray(s.allOf)) {
      for (const sub of s.allOf) await validate(value, sub, path, ctx, scope);
    }
    if (Array.isArray(s.anyOf)) {
      let matched = false;
      for (const sub of s.anyOf) {
        if (await matches(value, sub, path, ctx, scope)) {
          matched = true;
          break;
        }
      }
      if (!matched) fail(ctx, path, `does not match any of the ${s.anyOf.length} allowed schemas`, 'anyOf');
    }
    if (Array.isArray(s.oneOf)) {
      let count = 0;
      for (const sub of s.oneOf) {
        if (await matches(value, sub, path, ctx, scope)) count += 1;
      }
      if (count !== 1) {
        fail(ctx, path, `must match exactly one of the ${s.oneOf.length} schemas (matched ${count})`, 'oneOf');
      }
    }
    if (s.not !== undefined && (await matches(value, s.not, path, ctx, scope))) {
      fail(ctx, path, 'matches a schema it must not match', 'not');
    }
    if (s.if !== undefined) {
      const condition = await matches(value, s.if, path, ctx, scope);
      const branch = condition ? s.then : s.else;
      if (branch !== undefined) await validate(value, branch, path, ctx, scope);
    }
  } finally {
    ctx.depth -= 1;
  }
}

function parseInline(text: string, label: string, input: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ToolError(`${label} ${input} is not valid JSON: ${(error as Error).message}`);
  }
}

export const validateJsonTool: ToolSpec = {
  name: 'validate_json',
  description:
    'Validate JSON against a JSON Schema (draft 2020-12 subset, modular $ref files); reports every error with its JSON Pointer path.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      schema: { type: 'string', description: 'Inline schema or workspace .json path' },
      json: { type: 'string', description: 'Inline document' },
      path: { type: 'string', description: 'Workspace .json document' },
      maxErrors: { type: 'number', description: `Stop after this many errors (default ${MAX_ERRORS_DEFAULT})` },
    },
    required: ['schema'],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolOutcome> {
    const loadFile = async (absolute: string, label: string): Promise<unknown> => {
      let allowed: string;
      try {
        allowed = ctx.permissions.resolvePath(absolute, 'read');
      } catch (error) {
        throw new ToolError(`${label} cannot be read: ${(error as Error).message}`);
      }
      // A $ref is a pointer inside a document, not a path the caller typed, so it
      // stays confined: a hostile schema must not be able to page in files from
      // elsewhere on the machine. (The file tools themselves are not confined.)
      if (!ctx.permissions.isInside(allowed)) {
        throw new ToolError(`${label} "${relativePath(ctx.workspace, absolute)}" is outside the workspace`);
      }
      const info = await stat(allowed).catch(() => null);
      if (!info || !info.isFile()) throw new ToolError(`${label} not found: ${relativePath(ctx.workspace, allowed)}`);
      if (info.size > MAX_FILE_BYTES) throw new ToolError(`${label} is larger than ${MAX_FILE_BYTES / 1e6} MB`);
      const raw = await readFile(allowed, 'utf8');
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new ToolError(`${relativePath(ctx.workspace, allowed)} is not valid JSON: ${(error as Error).message}`);
      }
    };

    const schemaArg = args.schema;
    let schema: unknown;
    let schemaLabel: string;
    let schemaDir: string | null;
    if (typeof schemaArg === 'string') {
      const text = schemaArg.trim();
      if (text.startsWith('{') || text.startsWith('[') || text === 'true' || text === 'false') {
        schema = parseInline(text, 'Schema', 'argument');
        schemaLabel = 'the inline schema';
        schemaDir = null;
      } else {
        const absolute = ctx.permissions.resolvePath(text, 'read');
        const info = await stat(absolute).catch(() => null);
        if (!info || !info.isFile()) throw new ToolError(`Schema not found: ${text}`);
        if (info.size > MAX_SCHEMA_BYTES) throw new ToolError(`Schema ${text} is larger than ${MAX_SCHEMA_BYTES / 1e6} MB`);
        schema = await loadFile(absolute, 'Schema');
        schemaLabel = relativePath(ctx.workspace, absolute);
        schemaDir = dirname(absolute);
      }
    } else if (isObject(schemaArg) || typeof schemaArg === 'boolean') {
      schema = schemaArg;
      schemaLabel = 'the inline schema';
      schemaDir = null;
    } else {
      throw new ToolError('Missing "schema": pass inline JSON or a workspace path');
    }

    if (schema === null || (typeof schema !== 'object' && typeof schema !== 'boolean')) {
      throw new ToolError('A JSON Schema must be an object or a boolean');
    }

    const jsonArg = args.json;
    const pathArg = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : '';
    if (jsonArg === undefined && pathArg === '') {
      throw new ToolError('Pass the document as "json" (inline) or "path" (a workspace file)');
    }
    if (jsonArg !== undefined && pathArg !== '') {
      throw new ToolError('Pass either "json" or "path", not both');
    }

    const document =
      jsonArg !== undefined
        ? typeof jsonArg === 'string'
          ? parseInline(jsonArg, 'Document', 'argument')
          : jsonArg
        : await loadFile(ctx.permissions.resolvePath(pathArg, 'read'), 'Document');
    const documentLabel = jsonArg !== undefined ? 'the inline document' : pathArg;

    const requested = optionalNumber(args, 'maxErrors') ?? MAX_ERRORS_DEFAULT;
    const maxErrors = Math.max(1, Math.min(MAX_ERRORS_CAP, Math.floor(requested)));
    const errors: SchemaError[] = [];
    const context: Context = {
      errors,
      maxErrors,
      depth: 0,
      refs: 0,
      ignored: new Set<string>(),
      cache: new Map<string, unknown>(),
      load: (absolute) => loadFile(absolute, 'Referenced schema'),
    };

    await validate(document, schema, '', context, { root: schema, dir: schemaDir });

    const ignored = context.ignored.size > 0 ? `\nIgnored keywords (not supported): ${[...context.ignored].sort().join(', ')}` : '';
    if (errors.length === 0) {
      return {
        content: `VALID — ${documentLabel} matches ${schemaLabel}.${context.refs > 0 ? ` (${context.refs} $refs followed)` : ''}${ignored}`,
      };
    }

    const lines = errors.map((error) => `${shownPath(error.path)}: ${error.message}`);
    const stopped = errors.length >= maxErrors ? `\n(stopped after ${maxErrors} errors; raise maxErrors for more)` : '';
    return {
      content: truncate(
        `INVALID — ${errors.length} error(s) in ${documentLabel} against ${schemaLabel}\n${lines.join('\n')}${stopped}${ignored}`,
      ),
      isError: false,
    };
  },
};
