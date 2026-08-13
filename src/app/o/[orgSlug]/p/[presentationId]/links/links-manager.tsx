"use client";

/**
 * Share-link manager (M4): one codeless default link per presentation plus
 * any number of per-recipient coded links. Each carries recipient name, an
 * optional language/presenter override and an optional expiry. Copy button
 * yields the full public URL /p/{slug}-{lang}[-{code}].
 */

import { useState } from "react";
import { Lock, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import {
  createShareLink,
  deleteShareLink,
  setLinkPasscode,
  setShareLinkStatus,
  type CreateLinkInput,
} from "./actions";

export type LinkRow = {
  id: string;
  code: string | null;
  isDefault: boolean;
  recipientName: string | null;
  langOverride: string | null;
  presenterOverrideId: string | null;
  status: "live" | "draft" | "revoked";
  expiresAt: string | null;
  expired: boolean;
  hasPasscode: boolean;
  views: number;
};

type Presenter = { id: string; name: string };

const STATUS_STYLE: Record<string, string> = {
  live: "bg-ok-soft text-ok",
  draft: "bg-warn-soft text-warn",
  revoked: "bg-bad-soft text-bad",
};

/** Sentinel for "no presenter override" — shadcn Select forbids empty item values. */
const DEFAULT_PRESENTER = "__default__";

export function LinksManager({
  orgSlug,
  presentationId,
  presSlug,
  defaultLang,
  presenters,
  initial,
}: {
  orgSlug: string;
  presentationId: string;
  presSlug: string;
  defaultLang: string;
  presenters: Presenter[];
  initial: LinkRow[];
}) {
  const { run, pending } = useAction();
  const [form, setForm] = useState<CreateLinkInput | null>(null);
  const [revoking, setRevoking] = useState<LinkRow | null>(null);
  const [deleting, setDeleting] = useState<LinkRow | null>(null);
  const [passcodeFor, setPasscodeFor] = useState<LinkRow | null>(null);
  const [passcodeValue, setPasscodeValue] = useState("");

  const urlFor = (l: LinkRow) => {
    const lang = l.langOverride || defaultLang;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/p/${presSlug}-${lang}${l.code ? `-${l.code}` : ""}`;
  };

  const copy = async (l: LinkRow) => {
    try {
      await navigator.clipboard.writeText(urlFor(l));
      toast.success("URL copied");
    } catch {
      toast.error("Couldn't copy — select the URL manually");
    }
  };

  const submitNew = () => {
    if (!form) return;
    run(() => createShareLink(orgSlug, presentationId, form), {
      success: "Link created",
      onSuccess: () => setForm(null),
    });
  };

  return (
    <>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold">Share links</h3>
          <p className="mt-1 max-w-[560px] text-[13px] text-ink-2">
            The default link is your public URL. Create a coded link per prospect to personalise the
            greeting and track who opened what.
          </p>
        </div>
        <Button
          onClick={() =>
            setForm(
              form
                ? null
                : {
                    recipientName: "",
                    langOverride: "",
                    presenterOverrideId: "",
                    expiresAt: null,
                    passcode: "",
                  },
            )
          }
          disabled={pending}
          className="bg-linear-to-br from-accent-2 to-accent shadow-[0_12px_26px_-10px_rgba(61,91,245,.55)]"
        >
          <Plus /> New link
        </Button>
      </div>

      {form && (
        <div className="mt-4 grid grid-cols-1 gap-3 rounded-[14px] border border-accent-line bg-accent-soft px-4 py-4 md:grid-cols-2">
          <label className="block">
            <span className="eyebrow">Recipient name</span>
            <Input
              autoFocus
              className="mt-1.5 bg-panel"
              placeholder="Meridian Insurance Group"
              value={form.recipientName ?? ""}
              onChange={(e) => setForm({ ...form, recipientName: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="eyebrow">Language override</span>
            <Input
              className="mt-1.5 bg-panel"
              placeholder={`default: ${defaultLang}`}
              value={form.langOverride ?? ""}
              onChange={(e) => setForm({ ...form, langOverride: e.target.value })}
            />
          </label>
          <div className="block">
            <span className="eyebrow">Presenter override</span>
            <Select
              value={form.presenterOverrideId || DEFAULT_PRESENTER}
              onValueChange={(v) =>
                setForm({ ...form, presenterOverrideId: v === DEFAULT_PRESENTER ? "" : v })
              }
            >
              <SelectTrigger className="mt-1.5 w-full bg-panel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_PRESENTER}>Presentation default</SelectItem>
                {presenters.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="block">
            <span className="eyebrow">Expires (optional)</span>
            <Input
              type="date"
              className="mt-1.5 bg-panel"
              value={form.expiresAt ? form.expiresAt.slice(0, 10) : ""}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value || null })}
            />
          </label>
          <label className="block">
            <span className="eyebrow">Passcode (optional)</span>
            <Input
              className="mt-1.5 bg-panel"
              placeholder="Prospects must enter this to view"
              value={form.passcode ?? ""}
              onChange={(e) => setForm({ ...form, passcode: e.target.value })}
            />
          </label>
          <div className="flex items-center gap-3 md:col-span-2">
            <Button onClick={submitNew} disabled={pending}>
              Create link
            </Button>
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 overflow-hidden rounded-[16px] border border-line bg-panel shadow-card">
        {initial.map((l) => {
          const expired = l.expired;
          return (
            <div
              key={l.id}
              className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 last:border-none"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-semibold">
                    {l.isDefault ? "Default link" : l.recipientName || "Untitled recipient"}
                  </span>
                  <Badge
                    className={`rounded-full border-none px-2 py-0.5 text-[9.5px] font-bold tracking-[.08em] uppercase ${STATUS_STYLE[l.status]}`}
                  >
                    {l.status}
                  </Badge>
                  {expired && (
                    <Badge className="rounded-full border-none bg-bad-soft px-2 py-0.5 text-[9.5px] font-bold tracking-[.08em] text-bad uppercase">
                      expired
                    </Badge>
                  )}
                  {l.hasPasscode && (
                    <Badge className="flex items-center gap-1 rounded-full border-none bg-accent-soft px-2 py-0.5 text-[9.5px] font-bold tracking-[.08em] text-accent uppercase">
                      <Lock className="h-2.5 w-2.5" /> passcode
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-3">{urlFor(l)}</div>
                <div className="mt-0.5 text-[11px] text-ink-3">
                  {l.views} view{l.views === 1 ? "" : "s"}
                  {l.langOverride ? ` · ${l.langOverride}` : ""}
                  {l.expiresAt ? ` · expires ${l.expiresAt.slice(0, 10)}` : ""}
                </div>
              </div>

              <button
                onClick={() => copy(l)}
                className="rounded-full border border-accent-line bg-accent-soft px-3.5 py-1.5 text-[11.5px] font-semibold text-accent"
              >
                Copy URL
              </button>

              {l.status === "live" ? (
                <button
                  onClick={() => setRevoking(l)}
                  disabled={pending}
                  className="rounded-full border border-line px-3.5 py-1.5 text-[11.5px] font-semibold text-ink-2 disabled:opacity-50"
                >
                  Revoke
                </button>
              ) : (
                <button
                  onClick={() =>
                    run(() => setShareLinkStatus(orgSlug, presentationId, l.id, "live"), {
                      success: "Link updated",
                    })
                  }
                  disabled={pending}
                  className="rounded-full border border-line px-3.5 py-1.5 text-[11.5px] font-semibold text-ink-2 disabled:opacity-50"
                >
                  Activate
                </button>
              )}

              <button
                onClick={() => {
                  setPasscodeValue("");
                  setPasscodeFor(l);
                }}
                disabled={pending}
                className="rounded-full border border-line px-3.5 py-1.5 text-[11.5px] font-semibold text-ink-2 disabled:opacity-50"
              >
                {l.hasPasscode ? "Passcode" : "Set passcode"}
              </button>

              {!l.isDefault && (
                <button
                  onClick={() => setDeleting(l)}
                  disabled={pending}
                  className="rounded-full px-2.5 py-1.5 text-[11.5px] font-semibold text-bad disabled:opacity-50"
                >
                  Delete
                </button>
              )}
            </div>
          );
        })}
      </div>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this link?</AlertDialogTitle>
            <AlertDialogDescription>
              {revoking?.isDefault
                ? "The public URL will stop resolving until you activate it again."
                : `"${revoking?.recipientName || "This recipient"}" will no longer be able to open the pitch. You can activate the link again later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!revoking) return;
                run(() => setShareLinkStatus(orgSlug, presentationId, revoking.id, "revoked"), {
                  success: "Link revoked",
                  onSuccess: () => setRevoking(null),
                });
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this link permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              The URL will stop working immediately and its view history stays in analytics. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-bad text-white hover:bg-bad/90"
              onClick={() => {
                if (!deleting) return;
                run(() => deleteShareLink(orgSlug, presentationId, deleting.id), {
                  success: "Link deleted",
                  onSuccess: () => setDeleting(null),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={passcodeFor !== null} onOpenChange={(open) => !open && setPasscodeFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {passcodeFor?.hasPasscode ? "Change passcode" : "Set a passcode"}
            </DialogTitle>
            <DialogDescription>
              Viewers must enter this passcode before the pitch loads. Leave it blank and save to
              remove protection. The passcode is stored hashed — we can’t show the current one.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="e.g. meridian-2026"
            value={passcodeValue}
            onChange={(e) => setPasscodeValue(e.target.value)}
          />
          <DialogFooter className="gap-2 sm:justify-between">
            {passcodeFor?.hasPasscode ? (
              <Button
                variant="ghost"
                className="text-bad"
                disabled={pending}
                onClick={() => {
                  if (!passcodeFor) return;
                  run(() => setLinkPasscode(orgSlug, presentationId, passcodeFor.id, null), {
                    success: "Passcode removed",
                    onSuccess: () => setPasscodeFor(null),
                  });
                }}
              >
                Remove protection
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setPasscodeFor(null)}>
                Cancel
              </Button>
              <Button
                disabled={pending || !passcodeValue.trim()}
                onClick={() => {
                  if (!passcodeFor) return;
                  run(
                    () =>
                      setLinkPasscode(orgSlug, presentationId, passcodeFor.id, passcodeValue.trim()),
                    { success: "Passcode saved", onSuccess: () => setPasscodeFor(null) },
                  );
                }}
              >
                Save passcode
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
