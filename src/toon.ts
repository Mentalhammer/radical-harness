/**
 * Token-Oriented Object Notation (TOON): a compact, lossless encoding of the
 * JSON data model for model input. Indentation replaces braces, and uniform
 * arrays of objects become tabular:
 *
 *   { "forecast": [ { "day": "Mon", "temp": 4 }, { "day": "Tue", "temp": 7 } ] }
 *
 *   forecast[2]{day,temp}:
 *     Mon,4
 *     Tue,7
 *
 * The encoder and decoder are a matched pair: `decodeToon(encodeToon(x))`
 * round-trips any JSON value, and the decoder accepts the forms this encoder
 * emits. Deeply nested or non-uniform data falls back to list form, where JSON
 * can be smaller — `toonSavings()` measures the difference instead of guessing.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const INDENT = '  ';
const LITERALS = new Set(['true', 'false', 'null']);
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
/** Characters that would break a row, a header, or a key. */
const UNSAFE = /[,:[\]{}"\r\n\t]/;

export function isJsonObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: Json): value is null | boolean | number | string {
  return value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

function quote(text: string): string {
  return `"${text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

function needsQuotes(text: string): boolean {
  if (text === '') return true;
  if (LITERALS.has(text) || NUMBER.test(text)) return true;
  if (UNSAFE.test(text)) return true;
  // A leading dash is the list marker, so the scalar "-" would decode as an item.
  if (text.startsWith('-')) return true;
  return text !== text.trim();
}

function scalar(value: Json): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return needsQuotes(value) ? quote(value) : value;
  return '';
}

function key(name: string): string {
  return needsQuotes(name) ? quote(name) : name;
}

/** A column, or a group folded from a nested object with its own columns. */
export interface Field {
  name: string;
  children?: Field[];
}

function columnCount(fields: Field[]): number {
  return fields.reduce((total, field) => total + (field.children ? columnCount(field.children) : 1), 0);
}

function fieldHeader(fields: Field[]): string {
  return fields
    .map((field) => (field.children ? `${key(field.name)}{${fieldHeader(field.children)}}` : key(field.name)))
    .join(',');
}

function sameKeys(objects: Array<{ [key: string]: Json }>): string[] | null {
  const reference = Object.keys(objects[0] ?? {});
  if (reference.length === 0) return null;
  for (const object of objects) {
    const names = Object.keys(object);
    if (names.length !== reference.length) return null;
    if (!reference.every((name) => Object.prototype.hasOwnProperty.call(object, name))) return null;
  }
  return reference;
}

/** The shared column layout of uniform objects, or null when tabular form does not fit. */
function uniformFields(values: Json[]): Field[] | null {
  if (values.length === 0 || !values.every(isJsonObject)) return null;
  const objects = values as Array<{ [key: string]: Json }>;
  const names = sameKeys(objects);
  if (!names) return null;

  const fields: Field[] = [];
  for (const name of names) {
    const column = objects.map((object) => object[name] as Json);
    if (column.every(isPrimitive)) {
      fields.push({ name });
      continue;
    }
    if (!column.every(isJsonObject)) return null;
    const nested = uniformFields(column);
    if (!nested) return null;
    fields.push({ name, children: nested });
  }
  return fields;
}

/** One row's cells, in header order, descending into folded groups. */
function cellsFor(value: Json, fields: Field[]): string[] {
  const cells: string[] = [];
  for (const field of fields) {
    const cell = isJsonObject(value) ? (value[field.name] as Json) : null;
    if (field.children) cells.push(...cellsFor(cell, field.children));
    else cells.push(scalar(cell));
  }
  return cells;
}

function tabular(fields: Field[], indent: string, rows: string[]): string[] {
  return rows.map((row) => `${indent}${row}`);
}

/**
 * `name` is null for an array that is not stored under a key. An empty string is
 * a real key (`{"": [1]}`), so it must stay distinguishable from no key at all.
 */
function encodeArray(value: Json[], name: string | null, indent: string): string[] {
  const head = `${indent}${name === null ? '' : key(name)}`;
  if (value.length === 0) return [`${head}[0]:`];

  if (value.every(isPrimitive)) {
    return [`${head}[${value.length}]: ${value.map(scalar).join(',')}`];
  }

  const fields = uniformFields(value);
  if (fields) {
    const rows = (value as Array<{ [key: string]: Json }>).map((item) => cellsFor(item, fields).join(','));
    return [`${head}[${value.length}]{${fieldHeader(fields)}}:`, ...tabular(fields, indent + INDENT, rows)];
  }

  // List form: anything non-uniform or nested beyond one fold.
  const out: string[] = [`${head}[${value.length}]:`];
  for (const item of value) {
    if (isPrimitive(item)) {
      out.push(`${indent}${INDENT}- ${scalar(item)}`);
    } else if (isJsonObject(item)) {
      if (Object.keys(item).length === 0) {
        out.push(`${indent}${INDENT}-`);
      } else {
        out.push(`${indent}${INDENT}-`, ...encodeObject(item, indent + INDENT + INDENT));
      }
    } else {
      out.push(`${indent}${INDENT}-`, ...encodeArray(item, null, indent + INDENT + INDENT));
    }
  }
  return out;
}

function encodeObject(value: { [key: string]: Json }, indent: string): string[] {
  const entries = Object.entries(value);
  if (entries.length === 0) return [];

  const out: string[] = [];
  for (const [name, item] of entries) {
    if (isPrimitive(item)) {
      out.push(`${indent}${key(name)}: ${scalar(item)}`);
    } else if (Array.isArray(item)) {
      out.push(...encodeArray(item, name, indent));
    } else {
      const pairs = Object.entries(item);
      const keyed = pairs.length > 0 && pairs.every(([, entry]) => isJsonObject(entry));
      const fields = keyed ? uniformFields(pairs.map(([, entry]) => entry as Json)) : null;
      if (fields) {
        const rows = pairs.map(
          ([entryName, entry]) => `${indent}${INDENT}${key(entryName)}: ${cellsFor(entry, fields).join(',')}`,
        );
        out.push(`${indent}${key(name)}[${pairs.length}:]{${fieldHeader(fields)}}:`, ...rows);
      } else if (pairs.length === 0) {
        out.push(`${indent}${key(name)}:`);
      } else {
        out.push(`${indent}${key(name)}:`, ...encodeObject(item, indent + INDENT));
      }
    }
  }
  return out;
}

/** Encodes any JSON value as TOON text. An empty object encodes to an empty string. */
export function encodeToon(value: Json): string {
  if (isPrimitive(value)) return scalar(value);
  if (Array.isArray(value)) return encodeArray(value, null, '').join('\n');
  return encodeObject(value, '').join('\n');
}

/* ---------------------------------------------------------------- decoding */

interface Line {
  indent: number;
  text: string;
}

/** Splits a row on commas that are not inside quotes. */
function splitCells(text: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\' && index + 1 < text.length) {
        current += char + text[index + 1];
        index += 1;
      } else {
        if (char === '"') quoted = false;
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
      current += char;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function unquote(text: string): string {
  const value = text;
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  return value
    .slice(1, -1)
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Index of the first `target` outside a quoted span, or -1. Backslash escapes
 * are honoured, so a quoted key may itself contain quotes, colons, or brackets.
 */
function indexOutsideQuotes(text: string, target: string): number {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === target) return index;
  }
  return -1;
}

/** True when the whole line is one quoted string, which is a value, not a field. */
function isQuotedScalar(text: string): boolean {
  if (!text.startsWith('"')) return false;
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"') return index === text.length - 1;
  }
  return false;
}

function parseScalar(text: string): Json {
  const value = text.trim();
  if (value.startsWith('"')) return unquote(value);
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (NUMBER.test(value)) return Number(value);
  return value;
}

function fieldsFromHeader(header: string): Field[] {
  const fields: Field[] = [];
  let depth = 0;
  let current = '';
  let quoted = false;
  const flush = (): void => {
    const text = current.trim();
    current = '';
    if (text === '') return;
    const open = text.indexOf('{');
    if (open >= 0 && text.endsWith('}')) {
      fields.push({ name: unquote(text.slice(0, open)), children: fieldsFromHeader(text.slice(open + 1, -1)) });
    } else {
      fields.push({ name: unquote(text) });
    }
  };
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index] as string;
    // An escaped quote belongs to the name, it does not open or close a span.
    if (quoted && char === '\\') {
      current += char + (header[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '{') depth += 1;
    if (!quoted && char === '}') depth -= 1;
    if (!quoted && depth === 0 && char === ',') {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return fields;
}

function assignRow(fields: Field[], cells: string[], into: { [key: string]: Json }): void {
  let index = 0;
  for (const field of fields) {
    if (field.children) {
      const nested: { [key: string]: Json } = {};
      const count = columnCount(field.children);
      assignRow(field.children, cells.slice(index, index + count), nested);
      index += count;
      into[field.name] = nested;
    } else {
      into[field.name] = parseScalar(cells[index] ?? '');
      index += 1;
    }
  }
}

function toLines(text: string): Line[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = /^(\s*)(.*)$/.exec(line) as RegExpExecArray;
      return { indent: Math.floor((match[1] ?? '').length / INDENT.length), text: match[2] ?? '' };
    });
}

interface ParseState {
  rows: Line[];
  index: number;
}

interface ArrayHeader {
  name: string;
  /** False when the array is anonymous; an empty-string key is still a name. */
  hasName: boolean;
  count: number;
  keyed: boolean;
  header?: string;
  inline: string;
}

function arrayHeader(text: string): ArrayHeader | null {
  // The name may be a quoted string that itself contains brackets, so the
  // header's opening bracket is the first one outside quotes — not a regex match.
  const open = indexOutsideQuotes(text, '[');
  if (open < 0) return null;
  // A colon before the bracket means a scalar or a field line, not a header.
  const colon = indexOutsideQuotes(text, ':');
  if (colon >= 0 && colon < open) return null;

  const match = /^\[(\d+)(:?)\](?:\{(.*)\})?:(.*)$/.exec(text.slice(open));
  if (!match) return null;
  const [, count, keyed, header, rest] = match;
  return {
    name: unquote(text.slice(0, open)),
    hasName: open > 0,
    count: Number(count ?? 0),
    keyed: keyed === ':',
    header,
    inline: (rest ?? '').trim(),
  };
}

function parseList(state: ParseState, indent: number): Json[] {
  const items: Json[] = [];
  while (state.index < state.rows.length) {
    const line = state.rows[state.index] as Line;
    if (line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) break;
    state.index += 1;
    if (line.text === '-') {
      const nested = state.rows[state.index];
      if (nested && nested.indent > indent) {
        const head = arrayHeader(nested.text);
        const standalone = nested.text === '-' || nested.text.startsWith('- ') || (head !== null && !head.hasName);
        items.push(standalone ? parseBlock(state, nested.indent) : parseObject(state, nested.indent));
      } else {
        items.push({});
      }
    } else {
      items.push(parseScalar(line.text.slice(2)));
    }
  }
  return items;
}

function parseObject(state: ParseState, indent: number): { [key: string]: Json } {
  const object: { [key: string]: Json } = {};
  while (state.index < state.rows.length) {
    const line = state.rows[state.index] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      state.index += 1;
      continue;
    }
    if (line.text === '-' || line.text.startsWith('- ')) break;
    const entry = parseBlock(state, indent);
    if (isJsonObject(entry)) Object.assign(object, entry);
  }
  return object;
}

function parseBlock(state: ParseState, indent: number): Json {
  const line = state.rows[state.index];
  if (!line) return null;
  state.index += 1;
  const text = line.text;

  const header = arrayHeader(text);
  if (header) {
    const { name, hasName, count, keyed, header: columns, inline } = header;
    let value: Json;

    if (columns === undefined) {
      if (inline !== '') {
        value = splitCells(inline).map(parseScalar);
      } else {
        const next = state.rows[state.index];
        value = count > 0 && next && next.indent > indent ? parseList(state, next.indent) : [];
      }
    } else {
      const fields = fieldsFromHeader(columns);
      const rows: Json[] = [];
      for (let index = 0; index < count && state.index < state.rows.length; index += 1) {
        const row = state.rows[state.index] as Line;
        state.index += 1;
        const object: { [key: string]: Json } = {};
        if (keyed) {
          const colon = indexOutsideQuotes(row.text, ':');
          const entryName = unquote(colon >= 0 ? row.text.slice(0, colon).trim() : '');
          assignRow(fields, splitCells((colon >= 0 ? row.text.slice(colon + 1) : row.text).trim()), object);
          rows.push({ [entryName]: object });
        } else {
          assignRow(fields, splitCells(row.text.trim()), object);
          rows.push(object);
        }
      }
      value = keyed ? Object.assign({}, ...rows) : rows;
    }
    return hasName ? { [name]: value } : value;
  }

  if (text === '-') {
    const nested = state.rows[state.index];
    return nested && nested.indent > indent ? parseBlock(state, nested.indent) : {};
  }
  if (text.startsWith('- ')) return parseScalar(text.slice(2));

  // A quoted line is a value: the colons and braces inside it are its content.
  if (isQuotedScalar(text)) return parseScalar(text);

  if (text.endsWith(':')) {
    const name = unquote(text.slice(0, -1));
    const next = state.rows[state.index];
    let value: Json = {};
    if (next && next.indent > indent) {
      value = next.text === '-' || next.text.startsWith('- ') ? parseList(state, next.indent) : parseObject(state, next.indent);
    }
    return { [name]: value };
  }

  const colon = indexOutsideQuotes(text, ':');
  if (colon > 0) {
    return { [unquote(text.slice(0, colon).trim())]: parseScalar(text.slice(colon + 1)) };
  }
  return parseScalar(text);
}

/** Decodes text produced by `encodeToon`, including root arrays and scalars. */
export function decodeToon(text: string): Json {
  const rows = toLines(text);
  if (rows.length === 0) return {};
  const state: ParseState = { rows, index: 0 };
  const first = rows[0] as Line;
  const head = arrayHeader(first.text);
  if ((head && !head.hasName) || first.text === '-' || first.text.startsWith('- ')) {
    return parseBlock(state, 0);
  }
  if (rows.length === 1) return parseBlock(state, 0);
  return parseObject(state, 0);
}

/** Token counts for the same data as pretty JSON, compact JSON, and TOON. */
export function toonSavings(
  value: Json,
  estimate: (text: string) => number,
): { json: number; compact: number; toon: number; percent: number } {
  const pretty = estimate(JSON.stringify(value, null, 2));
  const compact = estimate(JSON.stringify(value));
  const encoded = estimate(encodeToon(value));
  const percent = pretty === 0 ? 0 : Math.round((1 - encoded / pretty) * 100);
  return { json: pretty, compact, toon: encoded, percent };
}
