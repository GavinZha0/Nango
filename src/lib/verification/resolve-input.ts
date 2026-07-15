import "server-only";

import {randomBytes, randomInt, randomUUID} from "node:crypto";

const LEAVE: unique symbol = Symbol("leave-token");
const EXACT_TOKEN_RE = /^\{\{\s*([^{}]+?)\}\}$/;
const EMBEDDED_TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

let counter = 0;
type Generator = (args: readonly number[]) => unknown;
const GENERATORS: Record<string, Generator> = {
  uuid: () => randomUUID(),
  uuidv7: () => uuidV7(),
  timestamp: () => Date.now(),
  isoTimestamp: () => new Date().toISOString(),
  int: (args) => {
    const [min, max] = args;
    if (args.length >= 2) {
      return randomInt(min, max + 1);
    }
    if (args.length === 1) {
      return randomInt(0, min + 1);
    }
    return randomInt(0, 2 ** 31);
  },
  randomString: (args) => randomAlnum(args[0] && args[0] > 0 ? args[0] : 16),
  counter: () => (counter += 1)
};



export function normalizeCaseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function resolveInput(
  input: Record<string, unknown>,
  context: Record<string, unknown> = {}
): Record<string, unknown> {
  const generated = deepRender(input, resolveGeneratorToken) as Record<string, unknown>;
  const resolved = deepRender(generated, (inner) => 
    resolveReferenceToken(inner, { ...generated, ...context })
  ) as Record<string, unknown>;
  return resolved;
}

export function substituteInputTemplates(
  value: unknown,
  input: unknown,
  context: Record<string, unknown> = {}
): unknown {
  return deepRender(value, (inner) => 
    resolveReferenceToken(inner, { input, ...context })
  );
}

function resolveGeneratorToken(inner: string): unknown | typeof LEAVE {
  const token = parseToken(inner);
  if (token.kind !== "generator") {
    return LEAVE;
  }
  const gen = GENERATORS[token.name];
  if (!gen) {
    return LEAVE;
  }
  return gen(token.args);
}

function resolveReferenceToken(inner: string, root: unknown): unknown | typeof LEAVE {
  const token = parseToken(inner);
  if (token.kind !== "reference") {
    return LEAVE;
  }
  const {found, value} = getByPath(root, token.path);
  return found ? value : LEAVE;
}

type TokenResolver = (inner: string) => unknown | typeof LEAVE;

function deepRender(node: unknown, resolve: TokenResolver): unknown {
  if (typeof node === "string") return renderString(node, resolve);
  if (Array.isArray(node)) {
    return node.map((item) => deepRender(item, resolve));
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = deepRender(v, resolve);
    }
    return out;
  }
  return node;
}

function renderString(str: string, resolve: TokenResolver): unknown {
  const exact = str.trim().match(EXACT_TOKEN_RE);
  if (exact) {
    const r = resolve(exact[1].trim());
    return r === LEAVE ? str : r;
  }
  return str.replace(EMBEDDED_TOKEN_RE, (whole, inner) => {
    const r = resolve(inner.trim());
    return r === LEAVE ? whole : stringify(r);
  });
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

type ParsedToken =
  | { kind: "generator"; name: string; args: number[] }
  | { kind: "reference"; path: string };
  
function parseToken(inner: string): ParsedToken {
  if (!inner.startsWith("$")) {
    return { kind: "reference", path: inner };
  }

  const body = inner.slice(1);
  const paren = body.indexOf("(");
  if (paren === -1) return {kind: "generator", name: body, args: []};
  const name = body.slice(0, paren);
  const argsRaw = body.slice(paren + 1).replace(/\)\s*$/, "");
  const args = argsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0).map((s) => Number(s)).filter((n) => Number.isFinite(n));

  return { kind: "generator", name, args };
}
  

function getByPath(root: unknown, path: string): { found: boolean; value: unknown } {
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter((s) => s.length > 0);

  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") {
      return { found: false, value: undefined };
    }
    if(!Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { found: false, value: undefined };
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { found: true, value: cur };
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomAlnum(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALNUM[bytes[i] % ALNUM.length];
  }
  return out;
}

function uuidV7(): string {
  const timeHex = Date.now().toString(16).padStart(12, "0").slice(-12);
  const bytes = Buffer.concat([Buffer.from(timeHex, "hex"), randomBytes(10)]);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}