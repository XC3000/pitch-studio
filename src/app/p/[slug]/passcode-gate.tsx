"use client";

/**
 * Passcode gate for a protected share link. Posts to /api/unlock; on success
 * the route sets the unlock cookie and we reload into the resolved viewer.
 */
import { useState } from "react";

export function PasscodeGate({
  linkId,
  recipientName,
}: {
  linkId: string;
  recipientName: string | null;
}) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim() || pending) return;
    setPending(true);
    setError(false);
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ linkId, passcode: passcode.trim() }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      setError(true);
    } catch {
      setError(true);
    }
    setPending(false);
  };

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center px-6 text-center"
      style={{ background: "linear-gradient(180deg,#F8FBFF 0%,#EFF5FC 60%,#E9F1FA 100%)" }}
    >
      <div className="eyebrow">Pitch Studio</div>
      <h1 className="mt-3 text-2xl text-[#1E293B]">This pitch is passcode-protected</h1>
      <p className="mt-2 max-w-sm text-sm text-[#64748B]">
        {recipientName
          ? `Enter the passcode shared with ${recipientName} to continue.`
          : "Enter the passcode you were sent to continue."}
      </p>
      <form onSubmit={submit} className="mt-6 flex w-full max-w-xs flex-col gap-3">
        <input
          autoFocus
          type="password"
          value={passcode}
          onChange={(e) => {
            setPasscode(e.target.value);
            setError(false);
          }}
          placeholder="Passcode"
          className="rounded-xl border border-[#CBD8EA] bg-white px-4 py-3 text-center text-[15px] text-[#1E293B] outline-none focus:border-[#3D5BF5]"
        />
        {error && <span className="text-[13px] text-[#E24545]">That passcode didn’t work.</span>}
        <button
          type="submit"
          disabled={pending || !passcode.trim()}
          className="rounded-xl bg-[#3D5BF5] px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Unlocking…" : "Unlock pitch"}
        </button>
      </form>
    </main>
  );
}
