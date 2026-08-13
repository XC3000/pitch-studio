"use client";

/** Presentation settings (M4): identity, default language/presenter, viewer
 *  branding, suggested questions and the closing/appendix copy. */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import { savePresentationSettings, type SettingsInput } from "./actions";

type Presenter = { id: string; name: string };

/** Sentinel for "no presenter" — shadcn Select forbids empty item values. */
const NO_PRESENTER = "__none__";

export function SettingsForm({
  orgSlug,
  presentationId,
  presenters,
  initial,
}: {
  orgSlug: string;
  presentationId: string;
  presenters: Presenter[];
  initial: SettingsInput;
}) {
  const { run, pending } = useAction();
  const [form, setForm] = useState<SettingsInput>(initial);
  const [badges, setBadges] = useState((initial.branding.badges ?? []).join(", "));
  const [questions, setQuestions] = useState((initial.suggestedQuestions ?? []).join("\n"));

  const set = (patch: Partial<SettingsInput>) => setForm({ ...form, ...patch });
  const setBrand = (patch: Partial<SettingsInput["branding"]>) =>
    setForm({ ...form, branding: { ...form.branding, ...patch } });

  const save = () => {
    const payload: SettingsInput = {
      ...form,
      branding: { ...form.branding, badges: badges.split(",").map((b) => b.trim()).filter(Boolean) },
      suggestedQuestions: questions.split("\n").map((q) => q.trim()).filter(Boolean),
    };
    run(() => savePresentationSettings(orgSlug, presentationId, payload), {
      success: "Settings saved",
    });
  };

  return (
    <div className="space-y-6">
      <Section title="Identity">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default language">
            <Input value={form.defaultLang} onChange={(e) => set({ defaultLang: e.target.value })} />
          </Field>
          <Field label="Default presenter">
            <Select
              value={form.defaultPresenterId ?? NO_PRESENTER}
              onValueChange={(v) => set({ defaultPresenterId: v === NO_PRESENTER ? null : v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PRESENTER}>None yet</SelectItem>
                {presenters.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="Viewer branding">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Brand mark (short)">
            <Input placeholder="CMA" value={form.branding.brandMark ?? ""} onChange={(e) => setBrand({ brandMark: e.target.value })} />
          </Field>
          <Field label="Brand name">
            <Input placeholder="CREDIBLE" value={form.branding.brandName ?? ""} onChange={(e) => setBrand({ brandName: e.target.value })} />
          </Field>
        </div>
        <Field label="Tagline">
          <Input placeholder="MEDICAL ASSISTANCE" value={form.branding.tagline ?? ""} onChange={(e) => setBrand({ tagline: e.target.value })} />
        </Field>
        <Field label="Badges (comma-separated)">
          <Input placeholder="ISO 9001:2015, GDPR, FULLY INSURED" value={badges} onChange={(e) => setBadges(e.target.value)} />
        </Field>
      </Section>

      <Section title="Q&A & closing">
        <Field label="Suggested questions (one per line)">
          <Textarea className="min-h-[90px]" value={questions} onChange={(e) => setQuestions(e.target.value)} />
        </Field>
        <Field label="Ending caption">
          <Textarea className="min-h-[70px]" value={form.endingCaption} onChange={(e) => set({ endingCaption: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3">
          <Field label="Appendix headline">
            <Input value={form.appendixHeadline} onChange={(e) => set({ appendixHeadline: e.target.value })} />
          </Field>
          <Field label="Appendix intro">
            <Textarea className="min-h-[70px]" value={form.appendixIntro} onChange={(e) => set({ appendixIntro: e.target.value })} />
          </Field>
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending} className="px-5">
          Save settings
        </Button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[16px] border border-line bg-panel px-5 py-4 shadow-card">
      <div className="eyebrow mb-3">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-semibold text-ink-2">{label}</span>
      {children}
    </label>
  );
}
