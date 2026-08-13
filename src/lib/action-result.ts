/**
 * Canonical result shape for every server action in the app.
 * Server side: wrap the action body in `safeAction()` (src/lib/safe-action.ts).
 * Client side: call it through `useAction()` (src/hooks/use-action.ts) which
 * toasts the error/success automatically.
 */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function ok(): ActionResult<void>;
export function ok<T>(data: T): ActionResult<T>;
export function ok<T>(data?: T): ActionResult<T | void> {
  return { ok: true, data: data as T };
}

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
