"use client";

/**
 * Knowledge console (M3): upload documents (presigned PUT → ingest pipeline),
 * typed facts, the editable Q&A fallback, and a test console that runs the
 * exact /api/qa retrieval + answer path. Indexing status polls while any
 * source is mid-pipeline — the mock's "indexing… 64%" row.
 */

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { runWithToast, useAction } from "@/hooks/use-action";
import {
  deleteDocument,
  deleteFact,
  finishDocumentUpload,
  getKnowledgeStatus,
  reindexDocument,
  saveFact,
  setDocumentRag,
  setDocumentScope,
  startDocumentUpload,
  testQuestion,
  updateFallbackText,
  type DocumentRow,
  type FactRow,
  type PresentationOption,
  type TestAnswer,
} from "./actions";

const ACTIVE_STATUSES = new Set(["uploaded", "parsing", "chunking", "embedding"]);
/** SelectItem values can't be empty — this sentinel stands in for "org-wide" (null). */
const ORG_SCOPE = "__org__";

type Props = {
  orgSlug: string;
  initialDocuments: DocumentRow[];
  initialFacts: FactRow[];
  presentations: PresentationOption[];
  fallbackText: string;
  inngestConnected?: boolean;
};

export function KnowledgeManager({
  orgSlug,
  initialDocuments,
  initialFacts,
  presentations,
  fallbackText,
  inngestConnected = true,
}: Props) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [facts, setFacts] = useState(initialFacts);
  const [inngestStatus, setInngestStatus] = useState(inngestConnected);
  const [uploading, setUploading] = useState(false);
  const [ragEnabled, setRagEnabled] = useState(true);
  const [uploadScope, setUploadScope] = useState<string>(ORG_SCOPE);
  const fileRef = useRef<HTMLInputElement>(null);
  const { run } = useAction();



  const refresh = async () => {
    try {
      const status = await getKnowledgeStatus(orgSlug);
      setDocuments(status.documents);
      setFacts(status.facts);
      if (typeof status.inngestConnected === "boolean") {
        setInngestStatus(status.inngestConnected);
      }

      // Follow up once or twice if an item is currently mid-pipeline so the UI updates to 'indexed'
      if (
        status.documents.some((d) => ACTIVE_STATUSES.has(d.status)) ||
        status.facts.some((f) => ACTIVE_STATUSES.has(f.status))
      ) {
        setTimeout(async () => {
          try {
            const nextStatus = await getKnowledgeStatus(orgSlug);
            setDocuments(nextStatus.documents);
            setFacts(nextStatus.facts);
            if (typeof nextStatus.inngestConnected === "boolean") {
              setInngestStatus(nextStatus.inngestConnected);
            }
          } catch {
            // ignore transient error
          }
        }, 1500);
      }
    } catch {
      // ignore transient error
    }
  };

  // ── upload flow: presign → PUT from the browser → enqueue ingest ──────────
  const onFilePicked = async (file: File) => {
    setUploading(true);
    try {
      const started = await run(
        () =>
          startDocumentUpload(orgSlug, {
            filename: file.name,
            mime: file.type,
            bytes: file.size,
            ragEnabled,
            presentationId: uploadScope === ORG_SCOPE ? null : uploadScope,
          }),
        { refresh: false },
      );
      if (!started) return;

      const put = await runWithToast(
        async () => {
          const res = await fetch(started.uploadUrl, {
            method: "PUT",
            headers: { "content-type": file.type || "application/octet-stream" },
            body: file,
          });
          if (!res.ok) {
            throw new Error(`Upload failed (${res.status}) — check R2 CORS allows PUT from this origin.`);
          }
          return true;
        },
        { loading: `Uploading ${file.name}…`, success: "Upload complete" },
      );
      if (!put) {
        await deleteDocument(orgSlug, started.documentId);
        return;
      }

      await run(() => finishDocumentUpload(orgSlug, started.documentId), {
        success: ragEnabled ? "Indexing started" : "Stored as evidence",
        refresh: false,
      });
      await refresh();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="mt-8 grid gap-5 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-5">
        <section className="rounded-[16px] border border-line bg-panel p-4 sm:p-5 shadow-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="eyebrow">Indexed sources</span>
              <div
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium border transition-colors",
                  inngestStatus
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                )}
                title={
                  inngestStatus
                    ? "Inngest background job worker is connected"
                    : "Inngest keys missing in environment variables"
                }
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    inngestStatus ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
                  )}
                />
                {inngestStatus ? "Inngest Connected" : "Inngest Disconnected"}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
              {presentations.length > 0 && (
                <Select value={uploadScope} onValueChange={setUploadScope}>
                  <SelectTrigger
                    size="sm"
                    className="h-7 max-w-[180px] sm:max-w-[220px] gap-1.5 border-line bg-panel-2 text-[11.5px] font-normal text-ink-2 truncate"
                    title="Which presentation this document is scoped to for Q&A retrieval"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ORG_SCOPE}>Org-wide</SelectItem>
                    {presentations.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Label
                className="flex items-center gap-1.5 text-[11.5px] font-normal text-ink-2"
                title="Off = stored as evidence only, never searched"
              >
                <Switch size="sm" checked={ragEnabled} onCheckedChange={setRagEnabled} />
                Add to Q&amp;A
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto p-0 text-xs font-semibold text-accent hover:bg-transparent hover:text-accent"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? "Uploading…" : "+ Add source"}
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFilePicked(f);
              }}
            />
          </div>
          <p className="mt-1 text-[11px] text-ink-3">
            {ragEnabled
              ? "New uploads are parsed, chunked & embedded for cited Q&A answers."
              : "New uploads are stored as evidence only — shown to viewers, never searched."}
            {presentations.length > 0 &&
              (uploadScope === ORG_SCOPE
                ? " Scope: org-wide — searchable from every presentation."
                : " Scope: this presentation is searched first, before org-wide.")}
          </p>
          {documents.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-ink-3">
              No sources yet — upload a PDF, DOCX or text file to power live Q&amp;A.
            </p>
          ) : (
            documents.map((d) => (
              <DocumentItem
                key={d.id}
                doc={d}
                orgSlug={orgSlug}
                presentations={presentations}
                onChanged={refresh}
              />
            ))
          )}
        </section>

        {/* typed facts */}
        <FactsCard orgSlug={orgSlug} facts={facts} onChanged={refresh} />
      </div>

      <div className="flex flex-col gap-5">
        <TestConsole orgSlug={orgSlug} />
        <FallbackCard orgSlug={orgSlug} fallbackText={fallbackText} />
      </div>
    </div>
  );
}

function StatusPill({ status, progressPct }: { status: string; progressPct?: number }) {
  if (status === "indexed") {
    return (
      <Badge className="rounded-full border-none bg-ok/10 px-2 py-0.5 text-[10.5px] font-semibold text-ok">
        indexed
      </Badge>
    );
  }
  if (status === "stored") {
    return (
      <Badge className="rounded-full border-none bg-panel-2 px-2 py-0.5 text-[10.5px] font-semibold text-ink-3">
        evidence only
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge className="rounded-full border-none bg-bad/10 px-2 py-0.5 text-[10.5px] font-semibold text-bad">
        failed
      </Badge>
    );
  }
  return (
    <Badge className="rounded-full border-none bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent">
      {status}
      {progressPct != null ? `… ${progressPct}%` : "…"}
    </Badge>
  );
}

function DocumentItem({
  doc,
  orgSlug,
  presentations,
  onChanged,
}: {
  doc: DocumentRow;
  orgSlug: string;
  presentations: PresentationOption[];
  onChanged: () => Promise<void>;
}) {
  const { run, pending } = useAction();
  const linkButton =
    "h-auto p-0 text-[11px] font-semibold hover:bg-transparent";
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line py-3 last:border-none">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-accent-soft text-base">📄</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{doc.filename}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <StatusPill status={doc.status} progressPct={ACTIVE_STATUSES.has(doc.status) ? doc.progressPct : undefined} />
            {doc.chunkCount > 0 && <span>{doc.chunkCount} chunks</span>}
            {presentations.length > 0 && (
              <Select
                value={doc.presentationId ?? ORG_SCOPE}
                onValueChange={(v) =>
                  run(() => setDocumentScope(orgSlug, doc.id, v === ORG_SCOPE ? null : v), {
                    success: "Scope updated",
                    onSuccess: () => void onChanged(),
                  })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="h-6 max-w-[140px] sm:max-w-[180px] gap-1 border-none bg-transparent px-1.5 py-0 text-[11px] font-normal text-ink-3 hover:text-ink truncate"
                  title="Retrieval scope"
                  disabled={pending}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ORG_SCOPE}>Org-wide</SelectItem>
                  {presentations.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {doc.error && <span className="truncate text-bad">{doc.error}</span>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2.5 sm:flex-none">
        {doc.ragEnabled && (doc.status === "failed" || doc.status === "indexed") && (
          <Button
            variant="ghost"
            size="sm"
            className={`${linkButton} text-accent hover:text-accent`}
            disabled={pending}
            onClick={() =>
              run(() => reindexDocument(orgSlug, doc.id), {
                success: "Reindex started",
                onSuccess: () => void onChanged(),
              })
            }
          >
            {doc.status === "failed" ? "Retry" : "Reindex"}
          </Button>
        )}
        {doc.status === "stored" ? (
          <Button
            variant="ghost"
            size="sm"
            className={`${linkButton} text-accent hover:text-accent`}
            disabled={pending}
            onClick={() =>
              run(() => setDocumentRag(orgSlug, doc.id, true), {
                success: "Q&A enabled — indexing started",
                onSuccess: () => void onChanged(),
              })
            }
          >
            Enable Q&amp;A
          </Button>
        ) : (
          doc.status === "indexed" && (
            <Button
              variant="ghost"
              size="sm"
              className={`${linkButton} text-ink-3 hover:text-ink`}
              disabled={pending}
              onClick={() =>
                run(() => setDocumentRag(orgSlug, doc.id, false), {
                  success: "Switched to store-only",
                  onSuccess: () => void onChanged(),
                })
              }
            >
              Store only
            </Button>
          )
        )}
        <Button
          variant="ghost"
          size="sm"
          className={`${linkButton} text-ink-3 hover:text-bad`}
          disabled={pending}
          onClick={() =>
            run(() => deleteDocument(orgSlug, doc.id), {
              success: "Document deleted",
              onSuccess: () => void onChanged(),
            })
          }
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function FactsCard({
  orgSlug,
  facts,
  onChanged,
}: {
  orgSlug: string;
  facts: FactRow[];
  onChanged: () => Promise<void>;
}) {
  const { run, pending } = useAction();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  return (
    <section className="rounded-[16px] border border-line bg-panel p-5 shadow-card">
      <span className="eyebrow">Typed facts</span>
      <p className="mt-1.5 text-[12px] text-ink-3">
        Curated answers indexed alongside documents — the fastest way to fix a Q&amp;A gap.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional) — e.g. UAE network coverage"
          className="bg-panel-2"
        />
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="The fact itself — plain sentences the presenter can speak."
          className="bg-panel-2 leading-relaxed"
        />
        <Button
          size="sm"
          className="self-end rounded-full px-4 text-[12px] font-semibold"
          disabled={pending || !body.trim()}
          onClick={() =>
            run(() => saveFact(orgSlug, { title, body }), {
              success: "Fact saved — indexing started",
              refresh: false,
              onSuccess: () => {
                setTitle("");
                setBody("");
                void onChanged();
              },
            })
          }
        >
          {pending ? "Saving…" : "Add fact"}
        </Button>
      </div>
      {facts.length > 0 && (
        <div className="mt-3 border-t border-line">
          {facts.map((f) => (
            <div key={f.id} className="flex items-start gap-3 border-b border-line py-3 last:border-none">
              <span className="mt-0.5 text-base">💡</span>
              <div className="min-w-0 flex-1">
                {f.title && <div className="text-[13px] font-semibold">{f.title}</div>}
                <div className="line-clamp-2 text-[12px] text-ink-2">{f.body}</div>
                <div className="mt-1">
                  <StatusPill status={f.status} />
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto flex-none p-0 text-[11px] font-semibold text-ink-3 hover:bg-transparent hover:text-bad"
                disabled={pending}
                onClick={() =>
                  run(() => deleteFact(orgSlug, f.id), {
                    success: "Fact deleted",
                    refresh: false,
                    onSuccess: () => void onChanged(),
                  })
                }
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FallbackCard({ orgSlug, fallbackText }: { orgSlug: string; fallbackText: string }) {
  const { run, pending } = useAction();
  const [text, setText] = useState(fallbackText);
  const [saved, setSaved] = useState(false);
  return (
    <section className="rounded-[16px] border border-line bg-panel p-4 sm:p-5 shadow-card">
      <span className="eyebrow">Fallback when nothing matches</span>
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        rows={3}
        className="mt-3 w-full bg-panel-2 px-4 py-3 text-[12.5px] leading-relaxed"
      />
      <div className="mt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <p className="text-[11px] text-ink-3">Spoken verbatim below the grounding threshold — never invented.</p>
        <Button
          size="sm"
          className="self-end sm:self-auto rounded-full px-4 text-[12px] font-semibold"
          disabled={pending || text.trim() === fallbackText || !text.trim()}
          onClick={() =>
            run(() => updateFallbackText(orgSlug, text), {
              success: "Fallback saved",
              onSuccess: () => setSaved(true),
            })
          }
        >
          {pending ? "Saving…" : saved ? "Saved ✓" : "Save"}
        </Button>
      </div>
    </section>
  );
}

function TestConsole({ orgSlug }: { orgSlug: string }) {
  const { run, pending } = useAction();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<TestAnswer | null>(null);

  const ask = () => {
    const q = question.trim();
    if (!q) return;
    run(() => testQuestion(orgSlug, q), {
      refresh: false,
      onSuccess: setResult,
    });
  };

  return (
    <section className="rounded-[16px] border border-line bg-panel p-4 sm:p-5 shadow-card">
      <span className="eyebrow">Test a question</span>
      <p className="mt-1.5 text-[12px] text-ink-3">
        Runs the exact retrieval + answer path viewers hit — check grounding before you send a link.
      </p>
      <div className="mt-3 flex gap-2">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="e.g. How many hospitals do you cover in the UAE?"
          className="min-w-0 flex-1 bg-panel-2"
        />
        <Button
          size="sm"
          className="flex-none rounded-full px-4 text-[12px] font-semibold"
          disabled={pending || !question.trim()}
          onClick={ask}
        >
          {pending ? "Thinking…" : "Ask"}
        </Button>
      </div>
      {result && (
        <div className="mt-3 rounded-[10px] border border-line bg-panel-2 p-3.5">
          <div className="text-[13px] leading-relaxed">{result.answer}</div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {result.hitFallback ? (
              <Badge className="rounded-full border-none bg-bad/10 px-2 py-0.5 text-[10.5px] font-semibold text-bad">
                fallback — content gap
              </Badge>
            ) : (
              [...new Map(result.citations.map((c) => [c.sourceName, c])).values()].map((c) => (
                <Badge
                  key={c.chunkId}
                  variant="outline"
                  className="rounded-full border-line bg-panel px-2 py-0.5 text-[10.5px] font-normal text-ink-2"
                >
                  📄 {c.sourceName}
                  {c.page ? ` · p.${c.page}` : ""}
                </Badge>
              ))
            )}
            <span className="text-[10.5px] text-ink-3 sm:ml-auto">
              confidence {(result.confidence * 100).toFixed(0)}% · {(result.latencyMs / 1000).toFixed(1)}s
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
