import { CreateOrganization } from "@clerk/nextjs";

export default function OnboardingPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 py-16">
      <div className="text-center">
        <div className="eyebrow">Welcome to Pitch Studio</div>
        <h1 className="mt-3 text-2xl text-ink">Create your organization</h1>
        <p className="mt-2 max-w-sm text-sm text-ink-2">
          Your organization holds your knowledge base, presenters and presentations — invite
          teammates once it&rsquo;s created.
        </p>
      </div>
      <CreateOrganization afterCreateOrganizationUrl="/o/:slug" />
    </main>
  );
}
