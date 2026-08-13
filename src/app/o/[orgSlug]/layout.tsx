import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import Script from "next/script";
import { AdminTabs } from "@/components/admin-tabs";
import { ThemeToggle } from "@/components/theme-toggle";
import { requireOrg } from "@/lib/auth";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrg(orgSlug);

  return (
    <div className="flex min-h-screen flex-col">
      {/* Restore theme before paint */}
      <Script id="ps-theme" strategy="beforeInteractive">
        {`try{var t=localStorage.getItem('ps-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}`}
      </Script>

      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-line bg-panel px-6 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-bold tracking-[.22em] text-ink uppercase">
            {org.name}
          </span>
        </div>
        <div className="h-6 w-px bg-line" />
        <span className="text-[15px] font-bold tracking-tight">Pitch Studio</span>
        <AdminTabs orgSlug={orgSlug} />
        <div className="ml-auto flex items-center gap-3">
          <OrganizationSwitcher
            afterSelectOrganizationUrl="/o/:slug"
            afterCreateOrganizationUrl="/o/:slug"
          />
          <ThemeToggle />
          <UserButton />
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
