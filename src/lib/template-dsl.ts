/**
 * The visual-template DSL — the primitive layout language a generated template
 * is expressed in (M5). A template `spec` is `{ paramSchema, layout }`:
 *
 *   - `paramSchema` declares the fillable params (a scene's `templateParams`
 *     supplies their values).
 *   - `layout` is a tree of **primitives only** — no code, no arbitrary props.
 *     The interpreter in `src/viewer/dsl-renderer.tsx` walks it and renders a
 *     fixed component per node. The worst a malicious/ugly proposal can do is
 *     look bad — nothing executes, no injection surface.
 *
 * This file is the single source of truth for the DSL: the zod schema, the
 * validator (structure + bindings + size caps), and the shared types. Keep the
 * primitive set here in lockstep with the renderer.
 *
 * A value in a node prop is either a literal or a binding `{ $bind: "path" }`
 * that pulls from the param scope (top-level params, plus the current item
 * under its `as` name inside a `repeat`).
 */
import { z } from "zod";

// ── binding ────────────────────────────────────────────────────────────────

/** A reference to a param (or repeat-item field): `{ $bind: "items" }`, `{ $bind: "row.value" }`. */
export const bindingSchema = z.object({ $bind: z.string().min(1).max(80) });
export type Binding = z.infer<typeof bindingSchema>;

const boundString = z.union([z.string(), z.number(), bindingSchema]);
const boundNumber = z.union([z.number(), bindingSchema]);
const boundBool = z.union([z.boolean(), bindingSchema]);
const boundStringArray = z.union([z.array(z.string()), bindingSchema]);

/** Animations restricted to keyframes that already exist in `viewer.css`. */
export const ANIM_NAMES = [
  "cuein",
  "chipin",
  "cardin",
  "fillbar",
  "traveldot",
  "starfill",
  "checkpop",
  "stagepulse",
] as const;
const animSchema = z.enum(ANIM_NAMES).optional();

// ── primitives ───────────────────────────────────────────────────────────────

// Recursive node type — declared up front so containers can reference it.
export type LayoutNode =
  | { type: "stack"; gap?: number; align?: "start" | "center" | "end"; anim?: (typeof ANIM_NAMES)[number]; children: LayoutNode[] }
  | { type: "row"; gap?: number; align?: "start" | "center" | "end"; justify?: "start" | "center" | "end" | "between"; anim?: (typeof ANIM_NAMES)[number]; children: LayoutNode[] }
  | { type: "grid"; cols: number; gap?: number; anim?: (typeof ANIM_NAMES)[number]; children: LayoutNode[] }
  | { type: "repeat"; each: Binding; as: string; child: LayoutNode }
  | { type: "text"; value: string | number | Binding; variant?: "title" | "value" | "label" | "note" | "body"; color?: "accent" | "ink" | "ok" | "bad" | "muted"; anim?: (typeof ANIM_NAMES)[number] }
  | { type: "metricChip"; value: string | number | Binding; label: string | number | Binding; anim?: (typeof ANIM_NAMES)[number] }
  | { type: "chip"; label: string | number | Binding; anim?: (typeof ANIM_NAMES)[number] }
  | { type: "progressBar"; label?: string | number | Binding; pct: number | Binding; value?: string | number | Binding; anim?: (typeof ANIM_NAMES)[number] }
  | { type: "stars"; count: number | Binding; label?: string | number | Binding; anim?: (typeof ANIM_NAMES)[number] }
  | { type: "docCard"; header: string | number | Binding; badge?: string | number | Binding; lines?: number | Binding; anim?: (typeof ANIM_NAMES)[number] }
  | { type: "checklist"; items: string[] | Binding; anim?: (typeof ANIM_NAMES)[number] }
  | { type: "flowNode"; title: string | number | Binding; sub?: string | number | Binding; done?: boolean | Binding; anim?: (typeof ANIM_NAMES)[number] };

const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("stack"),
      gap: z.number().min(0).max(80).optional(),
      align: z.enum(["start", "center", "end"]).optional(),
      anim: animSchema,
      children: z.array(layoutNodeSchema),
    }),
    z.object({
      type: z.literal("row"),
      gap: z.number().min(0).max(80).optional(),
      align: z.enum(["start", "center", "end"]).optional(),
      justify: z.enum(["start", "center", "end", "between"]).optional(),
      anim: animSchema,
      children: z.array(layoutNodeSchema),
    }),
    z.object({
      type: z.literal("grid"),
      cols: z.number().int().min(1).max(6),
      gap: z.number().min(0).max(80).optional(),
      anim: animSchema,
      children: z.array(layoutNodeSchema),
    }),
    z.object({
      type: z.literal("repeat"),
      each: bindingSchema,
      as: z.string().min(1).max(40).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "invalid item name"),
      child: layoutNodeSchema,
    }),
    z.object({
      type: z.literal("text"),
      value: boundString,
      variant: z.enum(["title", "value", "label", "note", "body"]).optional(),
      color: z.enum(["accent", "ink", "ok", "bad", "muted"]).optional(),
      anim: animSchema,
    }),
    z.object({ type: z.literal("metricChip"), value: boundString, label: boundString, anim: animSchema }),
    z.object({ type: z.literal("chip"), label: boundString, anim: animSchema }),
    z.object({
      type: z.literal("progressBar"),
      label: boundString.optional(),
      pct: boundNumber,
      value: boundString.optional(),
      anim: animSchema,
    }),
    z.object({ type: z.literal("stars"), count: boundNumber, label: boundString.optional(), anim: animSchema }),
    z.object({
      type: z.literal("docCard"),
      header: boundString,
      badge: boundString.optional(),
      lines: boundNumber.optional(),
      anim: animSchema,
    }),
    z.object({ type: z.literal("checklist"), items: boundStringArray, anim: animSchema }),
    z.object({
      type: z.literal("flowNode"),
      title: boundString,
      sub: boundString.optional(),
      done: boundBool.optional(),
      anim: animSchema,
    }),
  ]),
);

// ── param schema ─────────────────────────────────────────────────────────────

export const PARAM_TYPES = ["string", "number", "boolean", "string[]", "object[]"] as const;
export const paramSpecSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "invalid param name"),
  type: z.enum(PARAM_TYPES),
  label: z.string().max(120).optional(),
});
export type ParamSpec = z.infer<typeof paramSpecSchema>;

export const templateSpecSchema = z.object({
  paramSchema: z.array(paramSpecSchema).max(24),
  layout: layoutNodeSchema,
});
export type TemplateSpec = z.infer<typeof templateSpecSchema>;

// ── size caps (ugly-not-dangerous guard) ─────────────────────────────────────

const MAX_NODES = 80;
const MAX_DEPTH = 8;

function isBinding(v: unknown): v is Binding {
  return typeof v === "object" && v !== null && "$bind" in v;
}

/** Walk the tree, enforcing node-count/depth caps and collecting binding roots
 *  against the scopes in force (top-level params + any enclosing `repeat as`). */
function walk(
  node: LayoutNode,
  depth: number,
  scope: Set<string>,
  counters: { nodes: number },
  errors: string[],
) {
  counters.nodes += 1;
  if (counters.nodes > MAX_NODES) {
    if (counters.nodes === MAX_NODES + 1) errors.push(`layout exceeds ${MAX_NODES} nodes`);
    return;
  }
  if (depth > MAX_DEPTH) {
    errors.push(`layout nests deeper than ${MAX_DEPTH} levels`);
    return;
  }

  const checkBinding = (v: unknown) => {
    if (isBinding(v)) {
      const root = v.$bind.split(".")[0];
      if (!scope.has(root)) errors.push(`binding "${v.$bind}" refers to unknown param "${root}"`);
    }
  };

  switch (node.type) {
    case "stack":
    case "row":
    case "grid":
      for (const child of node.children) walk(child, depth + 1, scope, counters, errors);
      break;
    case "repeat": {
      checkBinding(node.each);
      const inner = new Set(scope);
      inner.add(node.as);
      walk(node.child, depth + 1, inner, counters, errors);
      break;
    }
    default: {
      // leaf: check every bound-able prop
      for (const [k, v] of Object.entries(node)) {
        if (k === "type" || k === "variant" || k === "color" || k === "anim") continue;
        checkBinding(v);
      }
    }
  }
}

export type ValidationResult =
  | { ok: true; spec: TemplateSpec }
  | { ok: false; errors: string[] };

const CONTAINER_TYPES = new Set(["stack", "row", "grid"]);

/**
 * Repair common model shape-slips before validation — reshapes only, never adds
 * node types or bindings, so it can't widen the safety envelope:
 *  - a container's `children` given as a single object → wrap in an array
 *  - a container given `child` instead of `children` → rename
 *  - a `repeat` whose `child` is an array (several elements per item) → wrap in a `stack`
 *  - a `repeat` given `children` instead of `child` → fold into a single `child`
 *  - a bare array where a node is expected (e.g. the root layout) → wrap in a `stack`
 * Anything it doesn't recognize is passed through untouched for zod to judge.
 */
function normalizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return { type: "stack", children: node.map(normalizeNode) };
  if (typeof node !== "object" || node === null) return node;

  const n = { ...(node as Record<string, unknown>) };
  const type = n.type;

  if (type === "repeat") {
    // `child` should be a single node; fold arrays / stray `children` into one.
    let child = n.child;
    if (child === undefined && n.children !== undefined) {
      child = n.children;
      delete n.children;
    }
    if (Array.isArray(child)) {
      child = child.length === 1 ? child[0] : { type: "stack", children: child };
    }
    if (child !== undefined) n.child = normalizeNode(child);
    return n;
  }

  if (typeof type === "string" && CONTAINER_TYPES.has(type)) {
    let children = n.children;
    if (children === undefined && n.child !== undefined) {
      children = n.child;
      delete n.child;
    }
    if (children !== undefined && !Array.isArray(children)) children = [children];
    if (Array.isArray(children)) n.children = children.map(normalizeNode);
    return n;
  }

  return n;
}

function normalizeSpec(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const spec = raw as Record<string, unknown>;
  if (!("layout" in spec)) return raw;
  return { ...spec, layout: normalizeNode(spec.layout) };
}

/** Full validation: normalize shape-slips → zod structure → size caps → binding resolvability. */
export function validateTemplateSpec(rawInput: unknown): ValidationResult {
  const raw = normalizeSpec(rawInput);
  const parsed = templateSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`).slice(0, 12),
    };
  }
  const spec = parsed.data;
  const errors: string[] = [];
  const scope = new Set(spec.paramSchema.map((p) => p.name));
  walk(spec.layout, 0, scope, { nodes: 0 }, errors);
  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 12) };
  return { ok: true, spec };
}

/** Compact, LLM-facing description of the DSL — injected into the proposal prompt. */
export const DSL_PROMPT_REFERENCE = `A template spec is JSON: { "paramSchema": ParamSpec[], "layout": Node }.
ParamSpec = { "name": string, "type": "string"|"number"|"boolean"|"string[]"|"object[]", "label"?: string }.
A value in a node is a literal, or a binding { "$bind": "paramName" } (inside a "repeat", also { "$bind": "itemName.field" }).
Nodes (use ONLY these "type" values):
- Containers: { "type":"stack", "gap"?, "align"?:"start|center|end", "children":Node[] }
              { "type":"row", "gap"?, "align"?, "justify"?:"start|center|end|between", "children":Node[] }
              { "type":"grid", "cols":1-6, "gap"?, "children":Node[] }
              { "type":"repeat", "each":{"$bind":"listParam"}, "as":"item", "child":Node }  // iterate an array param
- Leaves:    { "type":"text", "value":Bound, "variant"?:"title|value|label|note|body", "color"?:"accent|ink|ok|bad|muted" }
             { "type":"metricChip", "value":Bound, "label":Bound }   // big number over a small caption
             { "type":"chip", "label":Bound }                         // pill tag
             { "type":"progressBar", "label"?:Bound, "pct":BoundNumber, "value"?:Bound }
             { "type":"stars", "count":BoundNumber, "label"?:Bound }
             { "type":"docCard", "header":Bound, "badge"?:Bound, "lines"?:BoundNumber }
             { "type":"checklist", "items":BoundStringArray }
             { "type":"flowNode", "title":Bound, "sub"?:Bound, "done"?:BoundBool }
Optional "anim" on any node: one of ${ANIM_NAMES.map((a) => `"${a}"`).join(", ")}.
Prefer a "repeat" over a list param for anything repeated so the template is reusable. Keep it under ${MAX_NODES} nodes.`;
