/**
 * The 7 built-in cue templates — the animated illustration on stage while the
 * presenter speaks. Each renders from `cueParams` JSON (the filled template
 * spec on the scene row), so the same components later render generated
 * template proposals in the approval queue (M5).
 */
import type { CSSProperties } from "react";
import type { LayoutNode } from "@/lib/template-dsl";
import { DslRenderer } from "./dsl-renderer";

type Params = Record<string, unknown>;

const ACCENT = "#3D5BF5";

// ── pillars — a row of value/label chips (company intro) ────────────────────

function Pillars({ params }: { params: Params }) {
  const items = (params.items as { value: string; label: string }[]) ?? [];
  return (
    <div style={{ display: "flex", gap: 14, animation: "cuein .6s ease both" }}>
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            animation: `chipin .5s ease ${i * 0.12}s both`,
            background: "#fff",
            border: "1px solid rgba(61,91,245,.25)",
            borderRadius: 14,
            padding: "16px 20px",
            textAlign: "center",
            boxShadow: "0 16px 40px -22px rgba(30,58,138,.35)",
            minWidth: 120,
          }}
        >
          <div style={{ font: "700 20px Inter", color: ACCENT }}>{it.value}</div>
          <div style={{ marginTop: 4, font: "600 10px Inter", letterSpacing: ".6px", color: "#64748B" }}>
            {it.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── journey — staged flow with a traveling dot (case lifecycle) ─────────────

function Journey({ params }: { params: Params }) {
  const stages = (params.stages as { title: string; sub: string; done?: boolean }[]) ?? [];
  return (
    <div style={{ width: 660, animation: "cuein .6s ease both" }}>
      <div style={{ position: "relative", height: 2, background: "#DCE4F0", borderRadius: 2 }}>
        <div
          style={{
            position: "absolute",
            top: -4,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: ACCENT,
            boxShadow: "0 0 14px rgba(61,91,245,.7)",
            animation: "traveldot 6.5s ease-in-out infinite",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: -6 }}>
        {stages.map((st, i) => {
          const color = st.done ? "#22A06B" : ACCENT;
          const halo = st.done ? "rgba(34,160,107,.16)" : "rgba(61,91,245,.14)";
          return (
            <div key={i} style={{ textAlign: "center", width: 150 }}>
              <div
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  background: color,
                  margin: "0 auto",
                  boxShadow: `0 0 0 4px ${halo}`,
                }}
              />
              <div style={{ marginTop: 10, font: "700 11px Inter", letterSpacing: ".4px", color: "#1E293B" }}>
                {st.title}
              </div>
              <div style={{ font: "500 10px Inter", color: "#94A3B8" }}>{st.sub}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── network-map — pinging pins over faint connectors ────────────────────────

const DEFAULT_PINS = [
  { x: 18, y: 24, size: 9 },
  { x: 44, y: 16, size: 8 },
  { x: 68, y: 26, size: 9 },
  { x: 30, y: 62, size: 8 },
  { x: 62, y: 66, size: 8 },
  { x: 83, y: 52, size: 7, quiet: true },
];

function NetworkMap({ params }: { params: Params }) {
  const pins =
    (params.pins as { x: number; y: number; size: number; quiet?: boolean }[]) ?? DEFAULT_PINS;
  return (
    <div style={{ position: "relative", width: 640, height: 180, animation: "cuein .6s ease both" }}>
      <div
        style={{
          position: "absolute",
          left: "12%",
          top: "30%",
          width: 300,
          height: 1,
          background: "linear-gradient(90deg,transparent,rgba(61,91,245,.5),transparent)",
          transform: "rotate(8deg)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "40%",
          top: "60%",
          width: 240,
          height: 1,
          background: "linear-gradient(90deg,transparent,rgba(61,91,245,.4),transparent)",
          transform: "rotate(-14deg)",
        }}
      />
      {pins.map((p, i) => (
        <div key={i} style={{ position: "absolute", left: `${p.x}%`, top: `${p.y}%` }}>
          <div
            style={{
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: ACCENT,
              boxShadow: `0 0 ${p.quiet ? 10 : 12}px rgba(61,91,245,${p.quiet ? 0.5 : 0.6})`,
            }}
          />
          {!p.quiet && (
            <div
              style={{
                position: "absolute",
                inset: -10,
                border: "1.5px solid rgba(61,91,245,.45)",
                borderRadius: "50%",
                animation: "ping-dot 3s ease-out infinite",
                animationDelay: `${i * 0.6}s`,
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── gop-doc — approval document with live clock ─────────────────────────────

function GopDoc({ params }: { params: Params }) {
  const clock = (params.clock as string) ?? "00:47";
  const clockLabel = (params.clockLabel as string) ?? "AVG GOP TIME";
  const docHeader = (params.docHeader as string) ?? "GUARANTEE OF PAYMENT";
  const approved = (params.approvedLabel as string) ?? "✓ APPROVED";
  const stamp = (params.stamp as string[]) ?? ["CMA", "GOP"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 34, animation: "cuein .6s ease both" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ font: "700 40px Inter", color: ACCENT, fontVariantNumeric: "tabular-nums" }}>
          {clock}
        </div>
        <div style={{ marginTop: 2, font: "600 10px Inter", letterSpacing: 1, color: "#64748B" }}>
          {clockLabel}
        </div>
      </div>
      <div
        style={{
          width: 230,
          padding: "16px 18px",
          background: "#fff",
          border: "1px solid rgba(61,91,245,.3)",
          borderRadius: 12,
          boxShadow: "0 20px 48px -22px rgba(30,58,138,.4)",
          animation: "stagepulse 2.4s ease-in-out infinite",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 9, height: 9, background: ACCENT, borderRadius: 2 }} />
          <div style={{ font: "700 9px ui-monospace,Menlo,monospace", letterSpacing: "1.4px", color: "#64748B" }}>
            {docHeader}
          </div>
        </div>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {["90%", "64%", "78%"].map((w, i) => (
            <div key={i} style={{ height: 6, width: w, borderRadius: 3, background: "#EDF1F7" }} />
          ))}
        </div>
        <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ font: "700 9px ui-monospace,Menlo,monospace", color: "#22A06B" }}>{approved}</div>
          <div
            style={{
              width: 40,
              height: 40,
              border: "1.5px solid rgba(61,91,245,.55)",
              borderRadius: "50%",
              transform: "rotate(-14deg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              font: "700 7px ui-monospace,Menlo,monospace",
              color: ACCENT,
              textAlign: "center",
            }}
          >
            {stamp[0]}
            <br />
            {stamp[1]}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── rating — filling stars + retention bar ──────────────────────────────────

function Rating({ params }: { params: Params }) {
  const stars = (params.stars as number) ?? 5;
  const starsLabel = (params.starsLabel as string) ?? "";
  const barLabel = (params.barLabel as string) ?? "";
  const barPct = (params.barPct as number) ?? 0;
  const barValue = (params.barValue as string) ?? `${barPct}%`;
  const barNote = (params.barNote as string) ?? "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 40, animation: "cuein .6s ease both" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ display: "flex", gap: 6, fontSize: 30, lineHeight: 1, color: "#F5A623" }}>
          {Array.from({ length: stars }, (_, i) => (
            <span key={i} style={{ animation: `starfill .5s ease ${i * 0.12}s both` }}>
              ★
            </span>
          ))}
        </div>
        <div style={{ marginTop: 8, font: "600 11px Inter", letterSpacing: ".6px", color: "#64748B" }}>
          {starsLabel}
        </div>
      </div>
      <div style={{ width: 230 }}>
        <div style={{ display: "flex", justifyContent: "space-between", font: "600 10px Inter", color: "#64748B" }}>
          <span>{barLabel}</span>
          <span style={{ color: ACCENT }}>{barValue}</span>
        </div>
        <div style={{ marginTop: 8, height: 12, borderRadius: 6, background: "#E7EDF7", overflow: "hidden" }}>
          <div
            style={
              {
                height: "100%",
                borderRadius: 6,
                background: "linear-gradient(90deg,#3D5BF5,#6E8BFF)",
                "--w": `${barPct}%`,
                animation: "fillbar 1.4s cubic-bezier(.22,1,.36,1) both",
              } as CSSProperties
            }
          />
        </div>
        <div style={{ marginTop: 8, font: "500 10px Inter", color: "#94A3B8" }}>{barNote}</div>
      </div>
    </div>
  );
}

// ── invoice — line items checking off ───────────────────────────────────────

function Invoice({ params }: { params: Params }) {
  const header = (params.header as string) ?? "INVOICE";
  const badge = (params.badge as string) ?? "";
  const lines = (params.lines as number) ?? 3;
  const note = (params.note as string) ?? "";
  return (
    <div
      style={{
        width: 300,
        padding: "18px 20px",
        background: "#fff",
        border: "1px solid rgba(61,91,245,.28)",
        borderRadius: 14,
        boxShadow: "0 22px 52px -22px rgba(30,58,138,.4)",
        animation: "cuein .6s ease both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ font: "700 10px ui-monospace,Menlo,monospace", letterSpacing: "1.4px", color: "#64748B" }}>
          {header}
        </div>
        <div style={{ font: "700 11px Inter", color: "#22A06B" }}>{badge}</div>
      </div>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
        {Array.from({ length: lines }, (_, i) => (
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
                animation: `checkpop .4s ease ${i * 0.25}s both`,
              }}
            >
              ✓
            </span>
            <div style={{ height: 6, flex: 1, borderRadius: 3, background: "#EDF1F7" }} />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, font: "500 10px Inter", color: "#94A3B8" }}>{note}</div>
    </div>
  );
}

// ── route — cross-border journey with chips (case story) ────────────────────

function Route({ params }: { params: Params }) {
  const from = (params.from as string) ?? "";
  const to = (params.to as string) ?? "";
  const chips = (params.chips as string[]) ?? [];
  return (
    <div style={{ width: 560, animation: "cuein .6s ease both" }}>
      <div style={{ position: "relative", height: 60 }}>
        <div
          style={{
            position: "absolute",
            top: 44,
            left: "8%",
            right: "8%",
            height: 2,
            borderBottom: "2px dashed rgba(61,91,245,.4)",
          }}
        />
        <div style={{ position: "absolute", top: 44, left: "8%", transform: "translate(-50%,-50%)" }}>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "#E24545",
              boxShadow: "0 0 12px rgba(226,69,69,.5)",
            }}
          />
        </div>
        <div style={{ position: "absolute", top: 44, left: "92%", transform: "translate(-50%,-50%)" }}>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "#22A06B",
              boxShadow: "0 0 12px rgba(34,160,107,.5)",
            }}
          />
        </div>
        <div style={{ position: "absolute", top: 44, left: "8%", right: "8%", height: 0 }}>
          <div style={{ position: "relative", height: 0 }}>
            <div style={{ position: "absolute", fontSize: 22, top: -11, animation: "evacfly 5s ease-in-out infinite" }}>
              ✈️
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4%" }}>
        <div style={{ font: "700 11px Inter", color: "#E24545" }}>{from}</div>
        <div style={{ font: "700 11px Inter", color: "#22A06B" }}>{to}</div>
      </div>
      <div style={{ marginTop: 14, display: "flex", justifyContent: "center", gap: 10 }}>
        {chips.map((c, i) => (
          <div
            key={c}
            style={{
              font: "600 11px Inter",
              color: ACCENT,
              background: "#EEF3FF",
              border: "1px solid rgba(61,91,245,.3)",
              borderRadius: 999,
              padding: "6px 15px",
              animation: `chipin .5s ease ${i * 0.12}s both`,
            }}
          >
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── registry ────────────────────────────────────────────────────────────────

const CUE_COMPONENTS: Record<string, (props: { params: Params }) => React.ReactNode> = {
  pillars: Pillars,
  journey: Journey,
  "network-map": NetworkMap,
  "gop-doc": GopDoc,
  rating: Rating,
  invoice: Invoice,
  route: Route,
};

export function CueStage({
  template,
  params,
  spec,
}: {
  template: string;
  params: Params;
  /** generated-template DSL layout (M5); when present it takes precedence over
   *  the built-in key lookup and renders through the shared DSL interpreter. */
  spec?: LayoutNode | null;
}) {
  if (spec) return <DslRenderer layout={spec} params={params} />;
  const Cue = CUE_COMPONENTS[template];
  if (!Cue) return null;
  return <Cue params={params} />;
}
