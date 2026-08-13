"use client";

/**
 * Presentations list with inline CRUD (M4): create, rename, duplicate,
 * publish/unpublish, archive, delete. The row links into the Scene Builder.
 */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FileText, Loader2, MoreHorizontal, Plus, Sparkles, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAction } from "@/hooks/use-action";
import { deleteDocument, finishDocumentUpload, startDocumentUpload } from "./knowledge/actions";
import {
  createPresentation,
  createPresentationFromBrief,
  deletePresentation,
  duplicatePresentation,
  renamePresentation,
  setPresentationStatus,
} from "./actions";

export type PresentationRow = {
  id: string;
  name: string;
  slug: string;
  status: "draft" | "live" | "archived";
  sceneCount: number;
  linkCount: number;
};

type UploadFile = {
  tempId: string;
  documentId?: string;
  filename: string;
  ragEnabled: boolean;
  status: "uploading" | "done" | "error";
};

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-warn-soft text-warn",
  live: "bg-ok-soft text-ok",
  archived: "bg-panel-2 text-ink-3",
};

export function PresentationsBoard({
  orgSlug,
  initial,
}: {
  orgSlug: string;
  initial: PresentationRow[];
}) {
  const router = useRouter();
  const [rows] = useState(initial);
  const { run, pending } = useAction();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [brief, setBrief] = useState("");
  const [ragDefault, setRagDefault] = useState(true);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [renaming, setRenaming] = useState<PresentationRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<PresentationRow | null>(null);

  const anyUploading = files.some((f) => f.status === "uploading");

  const resetDialog = () => {
    setCreating(false);
    setNewName("");
    setBrief("");
    setFiles([]);
    setRagDefault(true);
  };

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const chosen = Array.from(list);
    if (fileInputRef.current) fileInputRef.current.value = "";
    for (const file of chosen) {
      const tempId = crypto.randomUUID();
      const rag = ragDefault;
      setFiles((prev) => [
        ...prev,
        { tempId, filename: file.name, ragEnabled: rag, status: "uploading" },
      ]);
      const fail = () =>
        setFiles((prev) => prev.map((f) => (f.tempId === tempId ? { ...f, status: "error" } : f)));
      try {
        const started = await startDocumentUpload(orgSlug, {
          filename: file.name,
          mime: file.type,
          bytes: file.size,
          ragEnabled: rag,
        });
        if (!started.ok) {
          toast.error(started.error);
          fail();
          continue;
        }
        const put = await fetch(started.data.uploadUrl, {
          method: "PUT",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) {
          await deleteDocument(orgSlug, started.data.documentId);
          toast.error(`Upload failed (${put.status}) — check R2 CORS allows PUT from this origin.`);
          fail();
          continue;
        }
        const finished = await finishDocumentUpload(orgSlug, started.data.documentId);
        if (!finished.ok) {
          toast.error(finished.error);
          fail();
          continue;
        }
        setFiles((prev) =>
          prev.map((f) =>
            f.tempId === tempId ? { ...f, documentId: started.data.documentId, status: "done" } : f,
          ),
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Upload failed");
        fail();
      }
    }
  };

  const removeFile = (tempId: string) => {
    const target = files.find((f) => f.tempId === tempId);
    if (target?.documentId) void deleteDocument(orgSlug, target.documentId);
    setFiles((prev) => prev.filter((f) => f.tempId !== tempId));
  };

  const onGenerate = () => {
    const name = newName.trim();
    if (!name) return;
    const documentIds = files
      .filter((f) => f.status === "done" && f.documentId)
      .map((f) => f.documentId as string);
    run(() => createPresentationFromBrief(orgSlug, { name, brief, documentIds }), {
      success: "Drafting your deck…",
      refresh: false,
      onSuccess: ({ presentationId }) => {
        resetDialog();
        router.push(`/o/${orgSlug}/p/${presentationId}`);
      },
    });
  };

  const onCreateBlank = () => {
    const name = newName.trim();
    if (!name) return;
    run(() => createPresentation(orgSlug, name), {
      success: `"${name}" created`,
      refresh: false,
      onSuccess: ({ presentationId }) => {
        resetDialog();
        router.push(`/o/${orgSlug}/p/${presentationId}`);
      },
    });
  };

  const onRename = () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) return;
    run(() => renamePresentation(orgSlug, renaming.id, name), {
      success: "Presentation renamed",
      onSuccess: () => setRenaming(null),
    });
  };

  return (
    <>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl">Presentations</h2>
          <p className="mt-1.5 max-w-[560px] text-[13px] text-ink-2">
            Each link is a personalised, avatar-led pitch — the link itself carries the recipient
            and language, and the matching presenter model delivers it.
          </p>
        </div>
        <Button
          onClick={() => setCreating(true)}
          disabled={pending}
          className="bg-linear-to-br from-accent-2 to-accent shadow-[0_12px_26px_-10px_rgba(61,91,245,.55)]"
        >
          <Plus /> New presentation
        </Button>
      </div>

      <Dialog open={creating} onOpenChange={(open) => (open ? setCreating(true) : resetDialog())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a presentation</DialogTitle>
            <DialogDescription>
              Give a short brief and drop in supporting documents — AI drafts the whole deck
              (narrative, scenes, scripts) and you refine it in the Scene Builder.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pres-name">Name</Label>
              <Input
                id="pres-name"
                autoFocus
                placeholder="e.g. Meridian Insurance Group"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pres-brief">Brief</Label>
              <Textarea
                id="pres-brief"
                rows={4}
                placeholder="What's this pitch about, who's the audience, and what should it land? A few sentences is plenty."
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Supporting documents</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload /> Add files
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.md,.csv"
                  className="hidden"
                  onChange={(e) => onFiles(e.target.files)}
                />
              </div>

              <label className="flex items-center gap-2.5 rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[12px] text-ink-2">
                <Switch checked={ragDefault} onCheckedChange={setRagDefault} />
                Also add new files to the Q&amp;A knowledge base (so prospects can ask about them).
                Every file is read for the draft either way.
              </label>

              {files.length > 0 && (
                <ul className="space-y-1.5">
                  {files.map((f) => (
                    <li
                      key={f.tempId}
                      className="flex items-center gap-2 rounded-[10px] border border-line bg-panel px-3 py-2 text-[12.5px]"
                    >
                      {f.status === "uploading" ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-ink-3" />
                      ) : (
                        <FileText className="size-4 shrink-0 text-ink-3" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                      {f.status === "done" && f.ragEnabled && (
                        <Badge className="bg-accent-soft text-accent">Q&amp;A</Badge>
                      )}
                      {f.status === "error" && <span className="text-[11px] text-bad">failed</span>}
                      <button
                        type="button"
                        aria-label="Remove"
                        className="text-ink-3 hover:text-ink"
                        onClick={() => removeFile(f.tempId)}
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button variant="ghost" onClick={onCreateBlank} disabled={pending || !newName.trim()}>
              Create blank instead
            </Button>
            <Button
              onClick={onGenerate}
              disabled={pending || anyUploading || !newName.trim()}
              className="bg-linear-to-br from-accent-2 to-accent"
            >
              <Sparkles /> {anyUploading ? "Uploading…" : "Generate deck"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mt-5 overflow-visible rounded-[16px] border border-line bg-panel shadow-card">
        {rows.length === 0 ? (
          <div className="px-8 py-16 text-center">
            <div className="eyebrow">No presentations yet</div>
            <p className="mx-auto mt-3 max-w-sm text-[13px] text-ink-2">
              Create your first pitch above, then build scenes from plain-words intent in the Scene
              Builder.
            </p>
          </div>
        ) : (
          rows.map((p) => (
            <div
              key={p.id}
              className="relative flex items-center gap-3 border-b border-line px-5 py-4 last:border-none hover:bg-panel-2"
            >
              <button
                onClick={() => router.push(`/o/${orgSlug}/p/${p.id}`)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="truncate text-[13.5px] font-semibold">{p.name}</span>
                <Badge
                  className={`rounded-full border-none px-2.5 py-1 text-[10px] font-bold tracking-[.08em] uppercase ${STATUS_STYLE[p.status]}`}
                >
                  {p.status}
                </Badge>
                <span className="text-[11px] text-ink-3">
                  {p.sceneCount} scene{p.sceneCount === 1 ? "" : "s"} · {p.linkCount} link
                  {p.linkCount === 1 ? "" : "s"}
                </span>
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Actions" disabled={pending}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {p.status !== "live" ? (
                    <DropdownMenuItem
                      onClick={() =>
                        run(() => setPresentationStatus(orgSlug, p.id, "live"), {
                          success: `"${p.name}" is live`,
                        })
                      }
                    >
                      Publish (go live)
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() =>
                        run(() => setPresentationStatus(orgSlug, p.id, "draft"), {
                          success: `"${p.name}" unpublished`,
                        })
                      }
                    >
                      Unpublish (to draft)
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => {
                      setRenameValue(p.name);
                      setRenaming(p);
                    }}
                  >
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      run(() => duplicatePresentation(orgSlug, p.id), {
                        success: `"${p.name}" duplicated`,
                      })
                    }
                  >
                    Duplicate
                  </DropdownMenuItem>
                  {p.status !== "archived" && (
                    <DropdownMenuItem
                      onClick={() =>
                        run(() => setPresentationStatus(orgSlug, p.id, "archived"), {
                          success: `"${p.name}" archived`,
                        })
                      }
                    >
                      Archive
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(p)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename presentation</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onRename()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button onClick={onRename} disabled={pending || !renameValue.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the presentation along with all of its scenes and share links. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-bad text-white hover:bg-bad/90"
              onClick={() => {
                if (!deleting) return;
                run(() => deletePresentation(orgSlug, deleting.id), {
                  success: `"${deleting.name}" deleted`,
                  onSuccess: () => setDeleting(null),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
