import { type ActionResult } from "@/lib/action-result";

/**
 * Throw inside a `safeAction()` body to surface a specific, user-facing
 * message. Any other thrown error is logged server-side and replaced with a
 * generic message so internals (SQL, stack traces, vendor errors) never leak
 * to the browser.
 */
export class ActionError extends Error {}

/** Next.js control-flow errors (redirect(), notFound()) must propagate. */
function isNextControlFlowError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_")
  );
}

/**
 * Standard wrapper for every server action body:
 *
 *   export async function renameThing(...): Promise<ActionResult<{ id: string }>> {
 *     return safeAction("renameThing", async () => {
 *       const { org } = await requireOrg(orgSlug);
 *       if (!name.trim()) throw new ActionError("Name cannot be empty");
 *       ...
 *       return { id };
 *     });
 *   }
 *
 * Catches everything, so callers can rely on always receiving an ActionResult.
 */
export async function safeAction<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    if (e instanceof ActionError) return { ok: false, error: e.message };
    console.error(`[action:${label}]`, e);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
