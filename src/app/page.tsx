import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function Home() {
  const { userId, orgSlug } = await auth();
  if (userId) {
    redirect(orgSlug ? `/o/${orgSlug}` : "/onboarding");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <div>
        <div className="eyebrow">Pitch Studio</div>
        <h1 className="mt-3 text-3xl text-ink">Your pitch, presented for you.</h1>
        <p className="mx-auto mt-3 max-w-md text-sm text-ink-2">
          Turn your sales pitch into an interactive, avatar-led presentation — metrics animate as
          they&rsquo;re spoken, evidence is one click away, and viewers can interrupt to ask
          anything.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/sign-up"
          className="rounded-[10px] bg-linear-to-br from-accent-2 to-accent px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_12px_26px_-10px_rgba(61,91,245,.55)]"
        >
          Create your studio
        </Link>
        <Link
          href="/sign-in"
          className="rounded-[10px] border border-line bg-panel px-5 py-2.5 text-[13px] font-semibold text-ink-2 hover:text-accent"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
