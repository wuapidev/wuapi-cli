#!/usr/bin/env node
// Generates src/generated/operations.ts: one entry per operation of the wuapi
// REST API, read from the OpenAPI spec (apps/wuapi/public/openapi.json) and
// named the way @wuapidev/sdk names it (`[operations]` in
// packages/sdk-codegen/wuapi.sdk.toml: operationId -> resource.method).
// Node built-ins only. Runs in the wuapi monorepo; the public mirror of this
// package has neither input, so there the committed file is used as is.
//
//   node scripts/gen-operations.mjs          write the file
//   node scripts/gen-operations.mjs --check  exit 1 when the committed file is stale

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = join(pkgDir, "../../apps/wuapi/public/openapi.json");
const TOML = join(pkgDir, "../sdk-codegen/wuapi.sdk.toml");
const OUT = join(pkgDir, "src/generated/operations.ts");
const METHODS = ["get", "post", "put", "patch", "delete"];

/** `[operations]` of wuapi.sdk.toml: operationId -> "resource.method". Only the forms that file uses. */
export function parseOperationsToml(text) {
  const out = {};
  let inOps = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inOps = line === "[operations]";
      continue;
    }
    if (!inOps) continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!m) throw new Error(`wuapi.sdk.toml: cannot read line: ${raw}`);
    const value = m[2];
    const plain = /^"([^"]+)"$/.exec(value);
    const table = /method\s*=\s*"([^"]+)"/.exec(value);
    const target = plain?.[1] ?? table?.[1];
    if (!target) throw new Error(`wuapi.sdk.toml: no method in: ${raw}`);
    out[m[1]] = target;
  }
  return out;
}

function firstParagraph(text, max) {
  const p = String(text ?? "").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return p.length > max ? `${p.slice(0, max - 1).trimEnd()}…` : p;
}

export function buildOperations(spec, mapping) {
  const schemas = spec.components?.schemas ?? {};
  const parameters = spec.components?.parameters ?? {};
  const deref = (s) => {
    let cur = s;
    for (let i = 0; cur && cur.$ref && i < 10; i++) cur = schemas[cur.$ref.split("/").pop()] ?? parameters[cur.$ref.split("/").pop()];
    return cur ?? {};
  };
  const typeOf = (schema) => {
    let s = schema ?? {};
    if (s.allOf && s.allOf.length === 1 && !s.type) s = { ...deref(s.allOf[0]), ...s, allOf: undefined };
    s = s.$ref ? deref(s) : s;
    if (s.const !== undefined) return JSON.stringify(s.const);
    if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
    if (s.oneOf || s.anyOf) {
      const parts = (s.oneOf ?? s.anyOf).map((x) => typeOf(x)).filter((t) => t !== "null");
      return [...new Set(parts)].join(" | ") || "any";
    }
    const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null") : s.type ? [s.type] : [];
    if (t.length === 0) return s.properties ? "object" : "any";
    if (t.length === 1 && t[0] === "array") return `${typeOf(s.items)}[]`;
    return t.join(" | ");
  };
  const fieldsOf = (schema) => {
    const s = deref(schema);
    const props = {};
    const required = new Set(s.required ?? []);
    for (const part of s.allOf ?? []) {
      const p = deref(part);
      Object.assign(props, p.properties ?? {});
      for (const r of p.required ?? []) required.add(r);
    }
    Object.assign(props, s.properties ?? {});
    return Object.entries(props)
      .filter(([, v]) => !v.readOnly)
      .map(([name, v]) => ({
        name,
        type: typeOf(v),
        required: required.has(name),
        description: firstParagraph(v.description ?? deref(v).description, 200),
      }));
  };
  const bodyVariants = (schema) => {
    const s = deref(schema);
    if (s.oneOf) {
      const byRef = {};
      for (const [key, ref] of Object.entries(s.discriminator?.mapping ?? {})) byRef[ref] = key;
      return s.oneOf.map((v) => ({ name: byRef[v.$ref] ?? (v.$ref ?? "").split("/").pop() ?? "", fields: fieldsOf(v) }));
    }
    return [{ name: "", fields: fieldsOf(s) }];
  };

  const ops = [];
  const seen = new Set();
  for (const [path, item] of Object.entries(spec.paths)) {
    const shared = item.parameters ?? [];
    for (const httpMethod of METHODS) {
      const op = item[httpMethod];
      if (!op) continue;
      const id = op.operationId;
      const target = mapping[id];
      if (!target) throw new Error(`operation ${id} is not in wuapi.sdk.toml [operations]`);
      seen.add(id);
      const segments = target.split(".");
      const method = segments.pop();
      const params = [...shared, ...(op.parameters ?? [])].map(deref);
      const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const query = params
        .filter((p) => p.in === "query")
        .map((p) => ({ name: p.name, type: typeOf(p.schema), required: Boolean(p.required), description: firstParagraph(p.description ?? deref(p.schema).description, 200) }));
      const content = op.requestBody?.content?.["application/json"];
      const hasBody = Boolean(content);
      const names = new Set(query.map((q) => q.name));
      ops.push({
        operationId: id,
        resource: segments,
        method,
        httpMethod: httpMethod.toUpperCase(),
        path,
        pathParams,
        query,
        hasBody,
        bodyRequired: Boolean(op.requestBody?.required),
        body: hasBody ? bodyVariants(content.schema) : [],
        paginated: httpMethod === "get" && names.has("cursor") && names.has("limit"),
        summary: op.summary ?? "",
        description: firstParagraph(op.description, 400),
        deprecated: Boolean(op.deprecated),
      });
    }
  }
  const extra = Object.keys(mapping).filter((id) => !seen.has(id));
  if (extra.length) throw new Error(`wuapi.sdk.toml names operations the spec lacks: ${extra.join(", ")}`);
  return ops;
}

export function render(ops) {
  return [
    "// Generated by scripts/gen-operations.mjs from apps/wuapi/public/openapi.json",
    "// and packages/sdk-codegen/wuapi.sdk.toml. Do not edit: run `npm run gen`.",
    "",
    'import type { Operation } from "../operation.js";',
    "",
    `export const OPERATIONS: readonly Operation[] = ${JSON.stringify(ops, null, 2)};`,
    "",
  ].join("\n");
}

export function generate() {
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const mapping = parseOperationsToml(readFileSync(TOML, "utf8"));
  return render(buildOperations(spec, mapping));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(SPEC) || !existsSync(TOML)) {
    console.error("gen-operations: the spec and wuapi.sdk.toml live in the wuapi monorepo; run this there.");
    process.exit(2);
  }
  const next = generate();
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (process.argv.includes("--check")) {
    if (current !== next) {
      console.error("src/generated/operations.ts is stale: run `npm run gen` in packages/wuapi-cli.");
      process.exit(1);
    }
    console.log("src/generated/operations.ts is up to date.");
  } else {
    writeFileSync(OUT, next);
    console.log(`Wrote src/generated/operations.ts`);
  }
}
