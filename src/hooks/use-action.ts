"use client";

import { useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";
import { toast } from "sonner";
import { type ActionResult } from "@/lib/action-result";

type RunOptions<T> = {
  /** Success toast — string, or derive it from the returned data. Omit for silent success. */
  success?: string | ((data: T) => string);
  /** Override the server's error message in the toast. */
  error?: string;
  /** Show a loading toast while the action runs. */
  loading?: string;
  /** Called with the data on success (close dialogs, reset inputs, navigate…). */
  onSuccess?: (data: T) => void;
  onError?: (message: string) => void;
  /** router.refresh() after success. Default true — server actions mutate server data. */
  refresh?: boolean;
};

/**
 * The one way client components call server actions.
 * Every call gets error handling + toasts for free:
 *
 *   const { run, pending } = useAction();
 *   run(() => renamePresentation(orgSlug, id, name), {
 *     success: "Presentation renamed",
 *     onSuccess: () => setEditing(false),
 *   });
 */
export function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    <T,>(action: () => Promise<ActionResult<T>>, opts: RunOptions<T> = {}): Promise<T | null> =>
      new Promise((resolve) => {
        startTransition(async () => {
          const loadingId = opts.loading ? toast.loading(opts.loading) : undefined;
          let res: ActionResult<T>;
          try {
            res = await action();
          } catch {
            // safeAction() should make this unreachable; keep the UI safe anyway.
            res = { ok: false, error: "Something went wrong. Please try again." };
          }
          if (loadingId !== undefined) toast.dismiss(loadingId);

          if (!res.ok) {
            const message = opts.error ?? res.error;
            toast.error(message);
            opts.onError?.(message);
            resolve(null);
            return;
          }

          if (opts.success) {
            toast.success(
              typeof opts.success === "function" ? opts.success(res.data) : opts.success,
            );
          }
          opts.onSuccess?.(res.data);
          if (opts.refresh !== false) router.refresh();
          resolve(res.data);
        });
      }),
    [router],
  );

  return { run, pending };
}

/**
 * For client-side async work that is NOT a server action (fetch to /api/*,
 * uploads to presigned URLs…). Same toast contract as useAction.
 */
export async function runWithToast<T>(
  work: () => Promise<T>,
  opts: { success?: string | ((data: T) => string); error?: string; loading?: string } = {},
): Promise<T | null> {
  const loadingId = opts.loading ? toast.loading(opts.loading) : undefined;
  try {
    const data = await work();
    if (loadingId !== undefined) toast.dismiss(loadingId);
    if (opts.success) {
      toast.success(typeof opts.success === "function" ? opts.success(data) : opts.success);
    }
    return data;
  } catch (e) {
    if (loadingId !== undefined) toast.dismiss(loadingId);
    toast.error(opts.error ?? (e instanceof Error ? e.message : "Something went wrong."));
    return null;
  }
}
