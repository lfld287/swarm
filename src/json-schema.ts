/**
 * Compile and validate object-rooted JSON Schemas for structured tool output.
 * Ajv checks the draft-07 meta-schema and compiles a validator; formats are
 * not validated. Disable logging so strict-mode diagnostics do not write to
 * the TUI. The contradiction check runs after successful compilation.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

/** The size guard: values visited, and nesting depth. */
const MAX_SCHEMA_NODES = 100_000;
const MAX_SCHEMA_DEPTH = 10_000;

/** Truncation for a disallowed property name and for a quoted enum/const value. */
const MAX_ERROR_KEY = 80;
const MAX_ERROR_VALUE = 300;

const INVALID_PREFIX = "Invalid JSON Schema: ";

export interface CompiledSchema {
  /** The schema as given, for the tool's `parameters`. */
  readonly schema: Record<string, unknown>;
  /** `true`, or a human-readable account of what is wrong. */
  check(value: unknown): true | string;
}

export type SchemaCompilation =
  | { ok: true; compiled: CompiledSchema }
  | { ok: false; message: string };

/** Compile a schema up front, before using it as a structured tool input. */
export function compileJsonSchema(schema: unknown): SchemaCompilation {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { ok: false, message: "Schema must be a JSON Schema object." };
  }
  const root = schema as Record<string, unknown>;

  try {
    JSON.stringify(root);
  } catch {
    return { ok: false, message: "Schema must be JSON-serializable." };
  }

  let validate: ValidateFunction;
  try {
    if (exceedsSizeGuard(root, { remaining: MAX_SCHEMA_NODES }, 0)) {
      return { ok: false, message: `${INVALID_PREFIX}schema too large` };
    }
    if (root.$async) return { ok: false, message: `${INVALID_PREFIX}$async schemas are not supported` };
    // Keep `$ref` resolution independent across compiled schemas.
    const ajv = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6, logger: false });
    if (!ajv.validateSchema(root)) return { ok: false, message: INVALID_PREFIX + ajv.errorsText(ajv.errors) };
    validate = ajv.compile(root);
  } catch (error) {
    return { ok: false, message: INVALID_PREFIX + (error instanceof Error ? error.message : String(error)) };
  }

  const finding = lintJsonSchema(root);
  if (finding !== undefined) {
    const consequence =
      finding.reason === "root_not_object"
        ? "the API only accepts an object-rooted tool input schema, so every request would be rejected"
        : finding.scope === "whole"
          ? "no output can satisfy this schema, so StructuredOutput validation would fail on every attempt"
          : "one property or item sub-schema admits no value, so any output that fills it in fails validation";
    return {
      ok: false,
      message: `Unusable JSON Schema — ${consequence}: ${finding.message}.`,
    };
  }

  return { ok: true, compiled: { schema: root, check: value => checkAgainst(validate, value) } };
}

/**
 * The size guard: true once more than `MAX_SCHEMA_NODES` values have
 * been visited or nesting passes `MAX_SCHEMA_DEPTH`. A stack overflow on a
 * pathologically deep schema reads as "too large" too.
 */
function exceedsSizeGuard(value: unknown, budget: { remaining: number }, depth: number): boolean {
  try {
    if (--budget.remaining < 0 || depth > MAX_SCHEMA_DEPTH) return true;
    if (typeof value !== "object" || value === null) return false;
    for (const child of Object.values(value)) {
      if (exceedsSizeGuard(child, budget, depth + 1)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function checkAgainst(validate: ValidateFunction, value: unknown): true | string {
  let valid: boolean;
  try {
    valid = validate(value) as boolean;
  } catch (error) {
    // Reported rather than thrown: a schema that compiled but trips on a
    // particular value must fail that call, not the run.
    return `the value could not be validated: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (valid) return true;
  const errors = validate.errors ?? [];
  if (errors.length === 0) return "the value does not match the required schema";
  return errors.map(error => describeError(error, value)).join(", ");
}

/** Describe an Ajv error with its path, message, and relevant value. */
function describeError(error: ErrorObject, root: unknown): string {
  const base = `${error.instancePath || "root"}: ${error.message}`;
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "additionalProperties": {
      const name = params.additionalProperty;
      return typeof name === "string" ? `${base} ('${truncate(name, MAX_ERROR_KEY)}' is not allowed)` : base;
    }
    case "minLength":
    case "maxLength": {
      const found = valueAt(root, error.instancePath);
      return typeof found === "string" ? `${base} (got ${[...found].length})` : base;
    }
    case "minItems":
    case "maxItems": {
      const found = valueAt(root, error.instancePath);
      return Array.isArray(found) ? `${base} (got ${found.length})` : base;
    }
    case "minProperties":
    case "maxProperties": {
      const found = valueAt(root, error.instancePath);
      return isNode(found) ? `${base} (got ${Object.keys(found).length})` : base;
    }
    case "enum": {
      const allowed = Array.isArray(params.allowedValues) ? quoteJson(params.allowedValues) : undefined;
      return allowed === undefined ? base : `${base}: ${allowed}`;
    }
    case "const": {
      const allowed = "allowedValue" in params ? quoteJson(params.allowedValue) : undefined;
      return allowed === undefined ? base : `${base}: ${allowed}`;
    }
    default:
      return base;
  }
}

/** The value a JSON Pointer names inside `root`, or undefined. */
function valueAt(root: unknown, pointer: string): unknown {
  let current = root;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isNode(current) && Object.hasOwn(current, key)) current = current[key];
    else return undefined;
  }
  return current;
}

function quoteJson(value: unknown): string | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return typeof json === "string" ? truncate(json, MAX_ERROR_VALUE) : undefined;
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/* ------------------------------------------------------------------ *
 * The unsatisfiability lint
 *
 * Reports only provable contradictions — a `required` name the
 * schema also forbids, an `enum` or `const` that contradicts `type`, crossed
 * bounds — never style. `whole` means no output can pass; `subschema` means
 * one optional property or array item can never be filled.
 * ------------------------------------------------------------------ */

/** Nesting depth and node budget past which the walk stops looking. */
const LINT_MAX_DEPTH = 32;
const LINT_MAX_NODES = 100_000;
/** Truncation for a property name and for a path, in a finding's message. */
const LINT_MAX_KEY = 80;
const LINT_MAX_PATH = 300;

const SIMPLE_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

export interface SchemaLintFinding {
  reason:
    | "root_not_object"
    | "required_property_forbidden"
    | "enum_type_mismatch"
    | "const_mismatch"
    | "crossed_bounds";
  scope: "whole" | "subschema";
  message: string;
}

type SchemaNode = Record<string, unknown>;

const isNode = (value: unknown): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Own keys only, so a schema cannot pick a keyword up from `Object.prototype`. */
const own = (node: SchemaNode, key: string): unknown => (Object.hasOwn(node, key) ? node[key] : undefined);

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A `required` entry worth checking: a string that is not an `Object.prototype` member. */
const isRequiredName = (value: unknown): value is string => typeof value === "string" && !(value in Object.prototype);

/** The first contradiction in `schema`, or undefined. A root that is not `type: "object"` is the first one. */
export function lintJsonSchema(schema: SchemaNode): SchemaLintFinding | undefined {
  // Own key and exact string: `type: ["object"]` is refused too.
  if (own(schema, "type") !== "object") {
    return {
      reason: "root_not_object",
      scope: "whole",
      message:
        "the root schema must declare type: 'object' (the API rejects any other root type for a tool input schema); "
        + "wrap arrays or primitives in an object property",
    };
  }
  return lintNode(schema, "", true, LINT_MAX_DEPTH, { remaining: LINT_MAX_NODES });
}

function lintNode(
  node: unknown,
  path: string,
  whole: boolean,
  depth: number,
  budget: { remaining: number },
): SchemaLintFinding | undefined {
  if (depth <= 0 || --budget.remaining < 0) return undefined;
  // A `$ref` target is not resolved, so nothing under it can be proven.
  if (!isNode(node) || Object.hasOwn(node, "$ref")) return undefined;

  const types = declaredTypes(node);
  const local = lintLocal(node, path, types);
  if (local !== undefined) return { ...local, scope: whole ? "whole" : "subschema" };

  const properties = own(node, "properties");
  if (allows(types, "object") && isNode(properties)) {
    const requiredList = own(node, "required");
    const required = new Set(Array.isArray(requiredList) ? requiredList.filter(isRequiredName) : []);
    // Only a property the object must carry can make the whole schema
    // unsatisfiable; an optional one can simply be left out.
    const mustBeObject = isExactly(types, "object");
    for (const [key, child] of Object.entries(properties)) {
      if (key === "__proto__") continue;
      const found = lintNode(
        child,
        `${path}/properties/${pointerToken(key)}`,
        whole && mustBeObject && required.has(key),
        depth - 1,
        budget,
      );
      if (found !== undefined) return found;
    }
  }

  const items = own(node, "items");
  if (allows(types, "array") && isNode(items)) return lintNode(items, `${path}/items`, false, depth - 1, budget);
  return undefined;
}

function lintLocal(
  node: SchemaNode,
  path: string,
  types: string[] | undefined,
): Omit<SchemaLintFinding, "scope"> | undefined {
  const where = path === "" ? "the root object" : `the sub-schema at ${truncatePath(path)}`;

  const required = own(node, "required");
  if (
    isExactly(types, "object")
    && Array.isArray(required)
    && own(node, "additionalProperties") === false
    && own(node, "patternProperties") === undefined
  ) {
    const properties = own(node, "properties");
    const declared = isNode(properties) ? properties : {};
    for (const name of required) {
      if (isRequiredName(name) && !Object.hasOwn(declared, name)) {
        return {
          reason: "required_property_forbidden",
          message: `${where} lists "${displayKey(name)}" in required but does not declare it in properties, and additionalProperties is false, so no object can satisfy it — declare the property or drop it from required`,
        };
      }
    }
  }

  const enumValues = own(node, "enum");
  if (types !== undefined && Array.isArray(enumValues) && enumValues.length > 0) {
    if (!enumValues.some(value => matchesType(types, value))) {
      return {
        reason: "enum_type_mismatch",
        message: `${where} declares type ${typeList(types)} but none of its enum values has that type, so no value can satisfy it — change type to match the enum values or vice versa`,
      };
    }
  }

  const constValue = own(node, "const");
  if (constValue !== undefined) {
    if (types !== undefined && !matchesType(types, constValue)) {
      return {
        reason: "const_mismatch",
        message: `${where} declares type ${typeList(types)} but its const value does not have that type, so no value can satisfy it`,
      };
    }
    if (
      Array.isArray(enumValues)
      && enumValues.length > 0
      && isPrimitive(constValue)
      && !enumValues.some(value => value === constValue)
    ) {
      return {
        reason: "const_mismatch",
        message: `${where} has a const value that is not one of its enum values, so no value can satisfy it`,
      };
    }
  }

  const bounds = crossedBounds(node, types);
  if (bounds !== undefined) {
    return { reason: "crossed_bounds", message: `${where} has ${bounds}, so no value can satisfy it` };
  }
  return undefined;
}

function crossedBounds(node: SchemaNode, types: string[] | undefined): string | undefined {
  if (isExactly(types, "number") || isExactly(types, "integer") || isPair(types, "number", "integer")) {
    const minimum = finite(own(node, "minimum"));
    const exclusiveMinimum = finite(own(node, "exclusiveMinimum"));
    const maximum = finite(own(node, "maximum"));
    const exclusiveMaximum = finite(own(node, "exclusiveMaximum"));
    // The tighter of each pair decides; an exclusive bound wins a tie.
    const lower =
      exclusiveMinimum !== undefined && (minimum === undefined || exclusiveMinimum >= minimum)
        ? { value: exclusiveMinimum, exclusive: true, keyword: "exclusiveMinimum" }
        : minimum !== undefined
          ? { value: minimum, exclusive: false, keyword: "minimum" }
          : undefined;
    const upper =
      exclusiveMaximum !== undefined && (maximum === undefined || exclusiveMaximum <= maximum)
        ? { value: exclusiveMaximum, exclusive: true, keyword: "exclusiveMaximum" }
        : maximum !== undefined
          ? { value: maximum, exclusive: false, keyword: "maximum" }
          : undefined;
    if (
      lower !== undefined
      && upper !== undefined
      && (lower.value > upper.value || (lower.value === upper.value && (lower.exclusive || upper.exclusive)))
    ) {
      return `${lower.keyword} ${lower.value} and ${upper.keyword} ${upper.value}, which admit no number`;
    }
  }
  if (isExactly(types, "string")) {
    const crossed = crossedPair(node, "minLength", "maxLength");
    if (crossed !== undefined) return crossed;
  }
  if (isExactly(types, "array")) {
    const crossed = crossedPair(node, "minItems", "maxItems");
    if (crossed !== undefined) return crossed;
  }
  if (isExactly(types, "object")) {
    const crossed = crossedPair(node, "minProperties", "maxProperties");
    if (crossed !== undefined) return crossed;
    const maxProperties = finite(own(node, "maxProperties"));
    const required = own(node, "required");
    if (maxProperties !== undefined && Array.isArray(required)) {
      const count = required.filter(isRequiredName).length;
      if (count > maxProperties) return `${count} required properties but maxProperties ${maxProperties}`;
    }
  }
  return undefined;
}

function crossedPair(node: SchemaNode, minKey: string, maxKey: string): string | undefined {
  const min = finite(own(node, minKey));
  const max = finite(own(node, maxKey));
  return min !== undefined && max !== undefined && min > max ? `${minKey} ${min} greater than ${maxKey} ${max}` : undefined;
}

/** `type` as a list, with `nullable: true` folded in; undefined when absent or unrecognised. */
function declaredTypes(node: SchemaNode): string[] | undefined {
  const type = own(node, "type");
  let types: string[];
  if (typeof type === "string" && SIMPLE_TYPES.has(type)) types = [type];
  else if (
    Array.isArray(type)
    && type.length > 0
    && type.every(entry => typeof entry === "string" && SIMPLE_TYPES.has(entry))
  ) {
    types = type.slice();
  } else return undefined;
  if (own(node, "nullable") === true && !types.includes("null")) types.push("null");
  return types;
}

/** No declared type allows anything. */
const allows = (types: string[] | undefined, type: string) => types === undefined || types.includes(type);
const isExactly = (types: string[] | undefined, type: string) =>
  types !== undefined && types.length === 1 && types[0] === type;
const isPair = (types: string[] | undefined, a: string, b: string) =>
  types !== undefined && types.length === 2 && ((types[0] === a && types[1] === b) || (types[0] === b && types[1] === a));

function matchesType(types: string[], value: unknown): boolean {
  return types.some(type => {
    switch (type) {
      case "null":
        return value === null;
      case "boolean":
        return typeof value === "boolean";
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "array":
        return Array.isArray(value);
      case "object":
        return isNode(value);
      default:
        return true;
    }
  });
}

const isPrimitive = (value: unknown) =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const typeList = (types: string[]) =>
  types.length === 1 ? `'${types[0]}'` : `[${types.map(type => `'${type}'`).join(", ")}]`;

/** A property name as quoted in a message: one line, no control characters, bounded. */
function displayKey(key: string): string {
  const clean = key.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > LINT_MAX_KEY ? `${clean.slice(0, LINT_MAX_KEY)}…` : clean;
}

const pointerToken = (key: string) => displayKey(key).replaceAll("~", "~0").replaceAll("/", "~1");

const truncatePath = (path: string) => (path.length > LINT_MAX_PATH ? `…${path.slice(-LINT_MAX_PATH)}` : path);
