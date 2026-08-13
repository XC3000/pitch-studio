/**
 * Presentational analytics dashboard (M6), shared by the org-wide page and the
 * per-presentation Analytics subtab. Pure server component — the data is
 * assembled in `lib/analytics.ts`; this only lays it out. Charts here are stat
 * tiles + single-hue magnitude bars (accent) with status color reserved for the
 * fallback rate, per the dataviz method (color follows the job, not the rank).
 */
import type { AnalyticsData, LinkStats } from "@/lib/analytics";

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "bad" | "ok";
}) {
  const valueColor =
    tone === "bad" ? "text-bad" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="rounded-[16px] border border-line bg-panel px-4 py-3.5 shadow-card">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1 text-[26px] font-bold tabular-nums ${valueColor}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

/** Single-hue magnitude bar anchored to the baseline. */
function Bar({ pct, tone }: { pct: number; tone?: "accent" | "bad" }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = tone === "bad" ? "var(--bad, #E24545)" : "var(--accent, #3D5BF5)";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/60">
      <div
        className="h-full rounded-full"
        style={{ width: `${clamped}%`, background: color }}
      />
    </div>
  );
}

function LinksTable({ links }: { links: LinkStats[] }) {
  const withActivity = links.filter((l) => l.opens > 0);
  const shown = withActivity.length > 0 ? withActivity : links;
  return (
    <div className="overflow-hidden rounded-[16px] border border-line bg-panel shadow-card">
      <div className="grid grid-cols-[1.6fr_repeat(4,0.7fr)_1.1fr] gap-3 border-b border-line px-5 py-3 text-[10.5px] font-bold tracking-[.06em] text-ink-3 uppercase">
        <span>Recipient</span>
        <span className="text-right">Opens</span>
        <span className="text-right">Unique</span>
        <span className="text-right">Questions</span>
        <span>Watch depth</span>
        <span className="text-right">Last opened</span>
      </div>
      {shown.length === 0 && (
        <div className="px-5 py-8 text-center text-[13px] text-ink-3">No share links yet.</div>
      )}
      {shown.map((l) => (
        <div
          key={l.linkId}
          className="grid grid-cols-[1.6fr_repeat(4,0.7fr)_1.1fr] items-center gap-3 border-b border-line px-5 py-3.5 text-[12.5px] last:border-none"
        >
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink">
              {l.isDefault ? "Default link" : l.recipientName || "Untitled recipient"}
            </div>
            <div className="truncate text-[11px] text-ink-3">{l.presentationName}</div>
          </div>
          <span className="text-right tabular-nums text-ink">{fmtInt(l.opens)}</span>
          <span className="text-right tabular-nums text-ink-2">{fmtInt(l.uniqueViewers)}</span>
          <span className="text-right tabular-nums text-ink-2">
            {fmtInt(l.questions)}
            {l.fallbacks > 0 && (
              <span className="text-bad"> ({fmtInt(l.fallbacks)} fb)</span>
            )}
          </span>
          <div>
            <Bar pct={l.avgWatchDepthPct} />
            <div className="mt-1 text-[10.5px] tabular-nums text-ink-3">
              {l.avgWatchDepthPct}%
            </div>
          </div>
          <span className="text-right text-[11.5px] text-ink-3">{fmtDate(l.lastOpenedAt)}</span>
        </div>
      ))}
    </div>
  );
}

function FallbackReport({ data }: { data: AnalyticsData["fallback"] }) {
  const highRate = data.rate >= 25 && data.total >= 4;
  return (
    <div className="rounded-[16px] border border-line bg-panel p-5 shadow-card">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[14px] font-bold text-ink">Fallback rate</h3>
        <span className={`text-[13px] font-semibold ${highRate ? "text-bad" : "text-ink-2"}`}>
          {data.fallbacks}/{data.total} answers · {data.rate}%
        </span>
      </div>
      <div className="mt-2.5">
        <Bar pct={data.rate} tone={highRate ? "bad" : "accent"} />
      </div>
      <p className="mt-2 text-[11.5px] text-ink-3">
        Share of live questions that fell back to the org message instead of a grounded answer. A
        rising rate means prospects are asking things the knowledge base can’t cover yet.
      </p>
      {data.recent.length > 0 && (
        <div className="mt-4">
          <div className="eyebrow mb-2">Recent unanswered questions</div>
          <ul className="flex flex-col gap-2">
            {data.recent.map((f, i) => (
              <li key={i} className="flex items-start justify-between gap-3 text-[12.5px]">
                <span className="text-ink">“{f.question}”</span>
                <span className="shrink-0 text-[11px] text-ink-3">
                  {f.recipientName ?? "—"} · {fmtDate(f.at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const USAGE_LABELS: Record<string, string> = {
  llm_generation: "Script & template generation",
  qa: "Q&A answers",
  embedding: "Embeddings",
  ocr: "OCR",
  render: "Avatar renders",
  tts: "Text-to-speech",
  storage: "Storage",
};

function UsageSection({ usage }: { usage: NonNullable<AnalyticsData["usage"]> }) {
  const max = Math.max(1, ...usage.byKind.map((k) => k.costUsd));
  return (
    <div className="rounded-[16px] border border-line bg-panel p-5 shadow-card">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[14px] font-bold text-ink">Usage & cost</h3>
        <span className="text-[13px] font-semibold text-ink-2">
          {fmtCost(usage.totalCostUsd)} total
        </span>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-3">
        Metered across every billable operation this org has run. This is the base for future
        quotas and billing.
      </p>
      {usage.byKind.length === 0 ? (
        <div className="mt-4 text-[13px] text-ink-3">No usage recorded yet.</div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {usage.byKind.map((k) => (
            <div key={k.kind}>
              <div className="flex items-baseline justify-between text-[12.5px]">
                <span className="text-ink">{USAGE_LABELS[k.kind] ?? k.kind}</span>
                <span className="tabular-nums text-ink-2">
                  {fmtCost(k.costUsd)}
                  <span className="ml-1.5 text-[11px] text-ink-3">
                    {fmtInt(k.events)} event{k.events === 1 ? "" : "s"}
                  </span>
                </span>
              </div>
              <div className="mt-1">
                <Bar pct={(k.costUsd / max) * 100} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AnalyticsView({
  data,
  scope,
}: {
  data: AnalyticsData;
  scope: "org" | "presentation";
}) {
  const o = data.overview;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Tile label="Opens" value={fmtInt(o.opens)} hint="view sessions" />
        <Tile label="Unique viewers" value={fmtInt(o.uniqueViewers)} hint="by IP" />
        <Tile label="Questions" value={fmtInt(o.questions)} hint="live Q&A asked" />
        <Tile label="Avg watch depth" value={`${o.avgWatchDepthPct}%`} hint="of scenes reached" />
        <Tile
          label="Fallback rate"
          value={`${o.fallbackRate}%`}
          hint="unanswered"
          tone={o.fallbackRate >= 25 && o.questions >= 4 ? "bad" : "default"}
        />
        <Tile label="Active links" value={fmtInt(o.activeLinks)} hint="live" />
      </div>

      <section>
        <h3 className="mb-2.5 text-[14px] font-bold text-ink">
          {scope === "org" ? "Links across all presentations" : "Share links"}
        </h3>
        <LinksTable links={data.links} />
      </section>

      <div className={`grid gap-6 ${data.usage ? "lg:grid-cols-2" : ""}`}>
        <FallbackReport data={data.fallback} />
        {data.usage && <UsageSection usage={data.usage} />}
      </div>
    </div>
  );
}
