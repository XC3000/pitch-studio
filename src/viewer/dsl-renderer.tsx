/**
 * The DSL interpreter — renders a validated template `layout` (see
 * `src/lib/template-dsl.ts`) as a fixed set of styled primitives. This is the
 * render path for **generated** templates (M5); the 7 hand-built built-ins in
 * `cues.tsx` are untouched.
 *
 * Pure and SSR-safe: it walks the node tree, resolves `{ $bind }` values
 * against the param scope (top-level params + the current `repeat` item), and
 * emits presentational components only. No user string ever becomes markup or
 * code — worst case is an ugly layout.
 *
 * The layout is expected to be validated by `validateTemplateSpec` before it
 * gets here (the queue preview and the viewer both do). If an unbound value or
 * unknown node slips through, it renders as empty rather than throwing.
 */
import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Binding, LayoutNode } from "@/lib/template-dsl";

const ACCENT = "#3D5BF5";
const COLORS = {
  accent: ACCENT,
  ink: "#1E293B",
  ok: "#22A06B",
  bad: "#E24545",
  muted: "#94A3B8",
} as const;

type Scope = Record<string, unknown>;

function isBinding(v: unknown): v is Binding {
  return typeof v === "object" && v !== null && "$bind" in (v as object);
}

/** Resolve a literal-or-binding value against the scope. */
function resolve(value: unknown, scope: Scope): unknown {
  if (!isBinding(value)) return value;
  const path = value.$bind.split(".");
  let cur: unknown = scope;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return "";
}
function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function animStyle(node: { anim?: string }): CSSProperties {
  if (!node.anim) return {};
  return { animation: `${node.anim} .6s ease both` };
}

// ── leaf primitives ──────────────────────────────────────────────────────────

const TEXT_STYLE: Record<string, CSSProperties> = {
  title: { font: "700 22px Inter", color: "#0F172A" },
  value: { font: "700 30px Inter", color: ACCENT, fontVariantNumeric: "tabular-nums" },
  label: { font: "600 11px Inter", letterSpacing: ".6px", color: "#64748B", textTransform: "uppercase" },
  note: { font: "500 11px Inter", color: "#94A3B8" },
  body: { font: "500 14px Inter", color: "#334155" },
};

function TextNode({ node, scope }: { node: Extract<LayoutNode, { type: "text" }>; scope: Scope }) {
  const base = TEXT_STYLE[node.variant ?? "body"];
  const color = node.color ? { color: COLORS[node.color] } : null;
  return <div style={{ ...base, ...color, ...animStyle(node) }}>{asText(resolve(node.value, scope))}</div>;
}

function MetricChip({ node, scope }: { node: Extract<LayoutNode, { type: "metricChip" }>; scope: Scope }) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid rgba(61,91,245,.25)",
        borderRadius: 14,
        padding: "16px 20px",
        textAlign: "center",
        boxShadow: "0 16px 40px -22px rgba(30,58,138,.35)",
        minWidth: 120,
        ...animStyle(node),
      }}
    >
      <div style={{ font: "700 20px Inter", color: ACCENT }}>{asText(resolve(node.value, scope))}</div>
      <div style={{ marginTop: 4, font: "600 10px Inter", letterSpacing: ".6px", color: "#64748B" }}>
        {asText(resolve(node.label, scope))}
      </div>
    </div>
  );
}

function Chip({ node, scope }: { node: Extract<LayoutNode, { type: "chip" }>; scope: Scope }) {
  return (
    <div
      style={{
        font: "600 11px Inter",
        color: ACCENT,
        background: "#EEF3FF",
        border: "1px solid rgba(61,91,245,.3)",
        borderRadius: 999,
        padding: "6px 15px",
        ...animStyle(node),
      }}
    >
      {asText(resolve(node.label, scope))}
    </div>
  );
}

function ProgressBar({ node, scope }: { node: Extract<LayoutNode, { type: "progressBar" }>; scope: Scope }) {
  const pct = Math.max(0, Math.min(100, asNumber(resolve(node.pct, scope))));
  const label = node.label != null ? asText(resolve(node.label, scope)) : "";
  const value = node.value != null ? asText(resolve(node.value, scope)) : `${Math.round(pct)}%`;
  return (
    <div style={{ width: 230, ...animStyle(node) }}>
      <div style={{ display: "flex", justifyContent: "space-between", font: "600 10px Inter", color: "#64748B" }}>
        <span>{label}</span>
        <span style={{ color: ACCENT }}>{value}</span>
      </div>
      <div style={{ marginTop: 8, height: 12, borderRadius: 6, background: "#E7EDF7", overflow: "hidden" }}>
        <div
          style={
            {
              height: "100%",
              borderRadius: 6,
              background: "linear-gradient(90deg,#3D5BF5,#6E8BFF)",
              "--w": `${pct}%`,
              animation: "fillbar 1.4s cubic-bezier(.22,1,.36,1) both",
            } as CSSProperties
          }
        />
      </div>
    </div>
  );
}

function Stars({ node, scope }: { node: Extract<LayoutNode, { type: "stars" }>; scope: Scope }) {
  const count = Math.max(0, Math.min(5, Math.round(asNumber(resolve(node.count, scope)))));
  const label = node.label != null ? asText(resolve(node.label, scope)) : "";
  return (
    <div style={{ textAlign: "center", ...animStyle(node) }}>
      <div style={{ display: "flex", gap: 6, fontSize: 30, lineHeight: 1, color: "#F5A623" }}>
        {Array.from({ length: count }, (_, i) => (
          <span key={i} style={{ animation: `starfill .5s ease ${i * 0.12}s both` }}>
            ★
          </span>
        ))}
      </div>
      {label && (
        <div style={{ marginTop: 8, font: "600 11px Inter", letterSpacing: ".6px", color: "#64748B" }}>{label}</div>
      )}
    </div>
  );
}

function DocCard({ node, scope }: { node: Extract<LayoutNode, { type: "docCard" }>; scope: Scope }) {
  const header = asText(resolve(node.header, scope));
  const badge = node.badge != null ? asText(resolve(node.badge, scope)) : "";
  const lines = Math.max(1, Math.min(6, Math.round(asNumber(resolve(node.lines, scope), 3))));
  return (
    <div
      style={{
        width: 230,
        padding: "16px 18px",
        background: "#fff",
        border: "1px solid rgba(61,91,245,.3)",
        borderRadius: 12,
        boxShadow: "0 20px 48px -22px rgba(30,58,138,.4)",
        ...animStyle(node),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ font: "700 9px ui-monospace,Menlo,monospace", letterSpacing: "1.4px", color: "#64748B" }}>
          {header}
        </div>
        {badge && <div style={{ font: "700 10px Inter", color: "#22A06B" }}>{badge}</div>}
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} style={{ height: 6, width: `${90 - i * 12}%`, borderRadius: 3, background: "#EDF1F7" }} />
        ))}
      </div>
    </div>
  );
}

function Checklist({ node, scope }: { node: Extract<LayoutNode, { type: "checklist" }>; scope: Scope }) {
  const raw = resolve(node.items, scope);
  const items = Array.isArray(raw) ? raw.map(asText) : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9, ...animStyle(node) }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "#E7F6EF",
              color: "#22A06B",
              font: "700 10px Inter",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              animation: `checkpop .4s ease ${i * 0.2}s both`,
            }}
          >
            ✓
          </span>
          <div style={{ font: "500 12px Inter", color: "#334155" }}>{it}</div>
        </div>
      ))}
    </div>
  );
}

function FlowNode({ node, scope }: { node: Extract<LayoutNode, { type: "flowNode" }>; scope: Scope }) {
  const done = !!resolve(node.done, scope);
  const color = done ? "#22A06B" : ACCENT;
  const halo = done ? "rgba(34,160,107,.16)" : "rgba(61,91,245,.14)";
  return (
    <div style={{ textAlign: "center", width: 150, ...animStyle(node) }}>
      <div
        style={{ width: 13, height: 13, borderRadius: "50%", background: color, margin: "0 auto", boxShadow: `0 0 0 4px ${halo}` }}
      />
      <div style={{ marginTop: 10, font: "700 11px Inter", letterSpacing: ".4px", color: "#1E293B" }}>
        {asText(resolve(node.title, scope))}
      </div>
      {node.sub != null && <div style={{ font: "500 10px Inter", color: "#94A3B8" }}>{asText(resolve(node.sub, scope))}</div>}
    </div>
  );
}

// ── container + dispatch ─────────────────────────────────────────────────────

function alignItems(a?: string): CSSProperties["alignItems"] {
  return a === "start" ? "flex-start" : a === "end" ? "flex-end" : "center";
}
function justifyContent(j?: string): CSSProperties["justifyContent"] {
  return j === "start" ? "flex-start" : j === "end" ? "flex-end" : j === "between" ? "space-between" : "center";
}

function renderNode(node: LayoutNode, scope: Scope, key?: number): ReactNode {
  switch (node.type) {
    case "stack":
      return (
        <div key={key} style={{ display: "flex", flexDirection: "column", gap: node.gap ?? 12, alignItems: alignItems(node.align), ...animStyle(node) }}>
          {node.children.map((c, i) => renderNode(c, scope, i))}
        </div>
      );
    case "row":
      return (
        <div key={key} style={{ display: "flex", gap: node.gap ?? 14, alignItems: alignItems(node.align), justifyContent: justifyContent(node.justify), ...animStyle(node) }}>
          {node.children.map((c, i) => renderNode(c, scope, i))}
        </div>
      );
    case "grid":
      return (
        <div key={key} style={{ display: "grid", gridTemplateColumns: `repeat(${node.cols}, minmax(0, 1fr))`, gap: node.gap ?? 14, ...animStyle(node) }}>
          {node.children.map((c, i) => renderNode(c, scope, i))}
        </div>
      );
    case "repeat": {
      const list = resolve(node.each, scope);
      if (!Array.isArray(list)) return null;
      return (
        <Fragment key={key}>
          {list.map((item, i) => renderNode(node.child, { ...scope, [node.as]: item }, i))}
        </Fragment>
      );
    }
    case "text":
      return <TextNode key={key} node={node} scope={scope} />;
    case "metricChip":
      return <MetricChip key={key} node={node} scope={scope} />;
    case "chip":
      return <Chip key={key} node={node} scope={scope} />;
    case "progressBar":
      return <ProgressBar key={key} node={node} scope={scope} />;
    case "stars":
      return <Stars key={key} node={node} scope={scope} />;
    case "docCard":
      return <DocCard key={key} node={node} scope={scope} />;
    case "checklist":
      return <Checklist key={key} node={node} scope={scope} />;
    case "flowNode":
      return <FlowNode key={key} node={node} scope={scope} />;
    default:
      return null;
  }
}

/**
 * Render a generated template's layout with the scene's params.
 * `layout` should already be validated; `params` is the scene's `templateParams`.
 */
export function DslRenderer({ layout, params }: { layout: LayoutNode; params: Record<string, unknown> }) {
  return <div style={{ animation: "cuein .6s ease both" }}>{renderNode(layout, params ?? {})}</div>;
}
