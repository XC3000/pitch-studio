/**
 * Seeds the CredibleAssist deck — org, built-in visual templates, metric
 * library, evidence documents, the 7-scene presentation and its share links.
 * Idempotent: re-running replaces the presentation content in place.
 *
 *   npm run db:seed
 */
import { and, eq, isNull } from "drizzle-orm";
import { env } from "../src/env";

async function main() {
  const { systemDb, schema } = await import("../src/db/system");

  const db = systemDb();

  // ── 1. Org ──────────────────────────────────────────────────────────────────

  const [org] = await db
    .insert(schema.organizations)
    .values({
      clerkOrgId: "seed_credibleassist",
      name: "CredibleAssist",
      slug: "credibleassist",
      accentColor: "#3D5BF5",
      qaFallbackText:
        "That's exactly the kind of question I'd take properly on a live call. In this preview I answer a handful of common ones — the production version connects you straight to our team, any time.",
    })
    .onConflictDoUpdate({
      target: schema.organizations.slug,
      set: { name: "CredibleAssist" },
    })
    .returning();
  console.log(`org: ${org.slug} (${org.id})`);

  // ── 2. Built-in visual templates (org_id null = shared library) ─────────────

  const BUILTIN_TEMPLATES = [
    { key: "pillars", name: "Pillars", note: "Row of value/label chips" },
    { key: "journey", name: "Journey", note: "Staged flow with traveling dot" },
    { key: "network-map", name: "Network map", note: "Pinging pins over connectors" },
    { key: "gop-doc", name: "Approval document", note: "Document card with live clock" },
    { key: "rating", name: "Rating", note: "Filling stars + progress bar" },
    { key: "invoice", name: "Invoice", note: "Line items checking off" },
    { key: "route", name: "Route", note: "Cross-border journey with chips" },
  ];

  const templateIds: Record<string, string> = {};
  for (const t of BUILTIN_TEMPLATES) {
    const existing = await db
      .select({ id: schema.visualTemplates.id })
      .from(schema.visualTemplates)
      .where(and(eq(schema.visualTemplates.key, t.key), isNull(schema.visualTemplates.orgId)));
    if (existing.length > 0) {
      templateIds[t.key] = existing[0].id;
      continue;
    }
    const [row] = await db
      .insert(schema.visualTemplates)
      .values({
        orgId: null,
        key: t.key,
        name: t.name,
        spec: { kind: "builtin", component: t.key, note: t.note },
        source: "builtin",
      })
      .returning();
    templateIds[t.key] = row.id;
  }
  console.log(`templates: ${Object.keys(templateIds).length} builtin`);

  // ── 3. Metric library ───────────────────────────────────────────────────────

  const METRICS = [
    { key: "cases", label: "CASES HANDLED", rawValue: "140000", format: { style: "number", suffix: "+" }, sublabel: "coordinated end-to-end" },
    { key: "completed", label: "CASES COMPLETED", rawValue: "96", format: { style: "percent" }, sublabel: "rest still in our hands" },
    { key: "countries", label: "COUNTRIES COVERED", rawValue: "50", format: { style: "number", suffix: "+" }, sublabel: "21,200+ cities · 4 continents" },
    { key: "net", label: "PROVIDERS", rawValue: "22650", format: { style: "number", suffix: "+" }, sublabel: "hospitals, clinics, doctors & evac" },
    { key: "response", label: "FIRST RESPONSE", rawValue: "8", format: { style: "duration", prefix: "≤", unit: "min" }, sublabel: "alarm centre, day or night" },
    { key: "gop", label: "GOP TURNAROUND", rawValue: null, format: { style: "literal", text: "≤1 hr" }, sublabel: "90% within 2 hrs" },
    { key: "sla", label: "SLA COMPLIANCE", rawValue: "98.4", format: { style: "percent", decimals: 1 }, sublabel: "trailing 12 months, audited" },
    { key: "satisfaction", label: "PATIENT SATISFACTION", rawValue: "4.7", format: { style: "rating", outOf: 5 }, sublabel: "escalations stay rare" },
    { key: "retention", label: "CLIENT RETENTION", rawValue: "96", format: { style: "percent" }, sublabel: "100+ partners renew" },
    { key: "invoice", label: "INVOICE ACCURACY", rawValue: "99.2", format: { style: "percent", decimals: 1 }, sublabel: "near-zero disputes" },
  ] as const;

  const metricIds: Record<string, string> = {};
  for (const m of METRICS) {
    const [row] = await db
      .insert(schema.metricLibraryItems)
      .values({ orgId: org.id, key: m.key, label: m.label, rawValue: m.rawValue, format: m.format, sublabel: m.sublabel })
      .onConflictDoUpdate({
        target: [schema.metricLibraryItems.orgId, schema.metricLibraryItems.key],
        set: { label: m.label, rawValue: m.rawValue, format: m.format, sublabel: m.sublabel },
      })
      .returning();
    metricIds[m.key] = row.id;
  }
  console.log(`metrics: ${Object.keys(metricIds).length}`);

  // ── 4. Evidence documents (placeholder rows; real uploads land in M3) ───────

  const EVIDENCE: Record<string, string[]> = {
    company: ["ISO 9001:2015 Certificate.pdf", "Company Profile & Licenses.pdf"],
    scale: ["Case Volume Report 2025.pdf", "Year-on-Year Growth Chart.pdf"],
    network: ["Hospital Network Master List.pdf", "Evacuation Partner Directory.pdf"],
    speed: ["SLA Compliance Report (12mo).pdf", "Alarm Centre Response Logs.pdf"],
    quality: ["Patient Satisfaction Survey.pdf", "Client Feedback & Retention Record.pdf"],
    finance: ["Billing & Invoice Accuracy Audit.pdf"],
    proof: ["Critical-Case Coordination File.pdf", "Cross-Border Evacuation Case Study.pdf", "Product Roadmap 2026.pdf"],
  };

  const docIds: Record<string, string[]> = {};
  for (const [group, names] of Object.entries(EVIDENCE)) {
    docIds[group] = [];
    for (const name of names) {
      const existing = await db
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .where(and(eq(schema.documents.orgId, org.id), eq(schema.documents.filename, name)));
      if (existing.length > 0) {
        docIds[group].push(existing[0].id);
        continue;
      }
      const [row] = await db
        .insert(schema.documents)
        .values({
          orgId: org.id,
          filename: name,
          mime: "application/pdf",
          r2Key: `seed/${name}`,
          status: "indexed",
          progressPct: 100,
        })
        .returning();
      docIds[group].push(row.id);
    }
  }
  console.log(`documents: ${Object.values(docIds).flat().length}`);

  // ── 5. Presentation (replaced in place on re-run) ───────────────────────────

  await db
    .delete(schema.presentations)
    .where(and(eq(schema.presentations.orgId, org.id), eq(schema.presentations.slug, "credible")));

  const CANNED_QA = [
    {
      patterns: ["middle east", "mena", "gulf", "uae", "dubai"],
      focus: ["sla"],
      sceneKey: "speed",
      answer:
        "In the Middle East we run dedicated desks in the UAE, Egypt and Türkiye — same alarm centre, same reporting stack, native Arabic coordination. Regional SLA compliance is tracking at ninety-eight percent over the last twelve months.",
    },
    {
      patterns: ["sla", "compliance", "service level"],
      focus: ["sla"],
      sceneKey: "speed",
      answer:
        "We hold ourselves to ninety-eight point four percent SLA compliance, measured monthly and audited quarterly — and every partner sees the same live dashboard we do.",
    },
    {
      patterns: ["gop", "guarantee", "payment", "approval"],
      focus: ["gop"],
      sceneKey: "speed",
      answer:
        "On average, a guarantee of payment leaves our desk in under an hour — day or night — and ninety percent of all GOPs are issued within two hours, weekends included.",
    },
    {
      patterns: ["hospital", "network", "provider", "clinic"],
      focus: ["net", "countries"],
      sceneKey: "network",
      answer:
        "More than twenty-two thousand healthcare providers hold direct-billing arrangements with us across fifty-plus countries — and where we don't yet have one, our team negotiates it on the spot, mid-case.",
    },
    {
      patterns: ["countr", "cover", "cities", "where", "region", "asia", "europe"],
      focus: ["countries"],
      sceneKey: "network",
      answer:
        "We're on the ground in more than fifty countries — across Asia, Europe, the Middle East and South America — with multilingual coordinators in every region.",
    },
    {
      patterns: ["retention", "client", "renew", "partner", "satisf"],
      focus: ["retention", "satisfaction"],
      sceneKey: "quality",
      answer:
        "Ninety-six percent of our clients renew with us year after year, and patients rate us four point seven out of five. In this business, retention is the honest metric.",
    },
    {
      patterns: ["case", "resolution", "fast", "speed", "long"],
      focus: ["cases", "completed"],
      sceneKey: "scale",
      answer:
        "We've handled over one hundred and forty thousand cases, ninety-six percent seen all the way through — because one case manager owns each case end to end, with live updates to your claims team.",
    },
    {
      patterns: ["invoice", "bill", "dispute", "finance"],
      focus: ["invoice"],
      sceneKey: "finance",
      answer:
        "Our invoices run over ninety-nine percent accurate, submitted fast, with disputes almost never — every figure is fully auditable, and the audit is on file.",
    },
  ];

  const [presentation] = await db
    .insert(schema.presentations)
    .values({
      orgId: org.id,
      name: "Meridian Insurance Group",
      slug: "credible",
      status: "live",
      defaultLang: "en",
      baseDeckLabel: "CredibleAssist master pitch",
      settings: {
        branding: {
          brandMark: "CMA",
          brandName: "CREDIBLE",
          tagline: "MEDICAL ASSISTANCE",
          badges: ["ISO 9001:2015", "GDPR", "FULLY INSURED"],
        },
        suggestedQuestions: [
          "What's your SLA in the Middle East?",
          "How fast are GOP approvals?",
          "How big is your provider network?",
        ],
        cannedQa: CANNED_QA,
        endingCaption:
          "That's Credible Medical Assistance. Every figure you saw is backed by documentation — open the evidence pack, ask me anything, or replay the walkthrough.",
        appendixHeadline: "Every figure in this review is backed by documentation.",
        appendixIntro:
          "Please review the supporting materials provided with this presentation. Each is available for your due diligence — accreditation, case records, the full provider network, service reports, feedback and audits.",
      },
    })
    .returning();
  console.log(`presentation: ${presentation.slug} (${presentation.id})`);

  // ── 6. Scenes ───────────────────────────────────────────────────────────────

  type SceneSeed = {
    key: string;
    name: string;
    title: string;
    subtitle: string;
    duration: number;
    template: string;
    cue: Record<string, unknown>;
    tilt: number;
    focus: string[];
    evidence: string;
    evidenceLabel: string;
    script: string;
  };

  const SCENES: SceneSeed[] = [
    {
      key: "company",
      name: "The Boardroom",
      title: "Credible Medical Assistance",
      subtitle: "Global medical assistance — around the clock, in every language",
      duration: 16,
      template: "pillars",
      cue: {
        items: [
          { value: "24/7", label: "ALWAYS ON" },
          { value: "Global", label: "50+ COUNTRIES" },
          { value: "ISO", label: "9001:2015" },
          { value: "Multi", label: "EVERY LANGUAGE" },
        ],
      },
      tilt: 0,
      focus: [],
      evidence: "company",
      evidenceLabel: "Accreditation & Licensing",
      script:
        "Hello — I'm the virtual Sadique, your guide to Credible Medical Assistance. Think of me as Sadique's stand-in: I hold the numbers, the records and the proof, and I'll walk you through them. Somewhere in the world right now, someone is far from home and needs help — that's the moment we exist for. We're 24/7, across the globe, ISO-certified, answering in whatever language the call comes in. And everything I show you, you can verify for yourself: the supporting documents sit in the top-right corner — look up there now, that's where the proof lives.",
    },
    {
      key: "scale",
      name: "Scale",
      title: "Every case is a real person",
      subtitle: "One case manager owns each case, first call to resolution",
      duration: 14,
      template: "journey",
      cue: {
        stages: [
          { title: "First call", sub: "member reaches us" },
          { title: "Case manager", sub: "one owner, end to end" },
          { title: "Treatment", sub: "OPD · IPD · tele" },
          { title: "Resolved", sub: "closed & reported", done: true },
        ],
      },
      tilt: -2,
      focus: ["cases", "completed"],
      evidence: "scale",
      evidenceLabel: "Case Volume & Growth",
      script:
        "Every one of these is a real person we helped. Over one hundred and forty thousand cases so far — ninety-six percent seen all the way through, the rest still in our hands today. Outpatient, inpatient, house-calls, telemedicine. And the number keeps climbing, year after year. It's all in our records.",
    },
    {
      key: "network",
      name: "Network",
      title: "Wherever your members go",
      subtitle: "We’re already there — 50+ countries, one connected network",
      duration: 12,
      template: "network-map",
      cue: {},
      tilt: -1.2,
      focus: ["countries", "net"],
      evidence: "network",
      evidenceLabel: "Provider Network",
      script:
        "Wherever your members go, we're already there — more than fifty countries, and over twenty-two thousand hospitals, clinics, doctors and evacuation partners. The full list is documented, hospital by hospital, for you to review.",
    },
    {
      key: "speed",
      name: "Speed",
      title: "When minutes matter",
      subtitle: "We answer fast, approve fast, and hold our commitments",
      duration: 13,
      template: "gop-doc",
      cue: {
        clock: "00:47",
        clockLabel: "AVG GOP TIME",
        docHeader: "GUARANTEE OF PAYMENT",
        approvedLabel: "✓ APPROVED",
        stamp: ["CMA", "GOP"],
      },
      tilt: 2.2,
      focus: ["response", "gop", "sla"],
      evidence: "speed",
      evidenceLabel: "Speed & SLA",
      script:
        "When someone's hurt, minutes matter. We pick up in under eight minutes, issue a guarantee of payment in under an hour, and hold ninety-eight point four percent on our service commitments. Not claims — measured, and reported.",
    },
    {
      key: "quality",
      name: "Quality",
      title: "Speed alone isn’t care",
      subtitle: "Patients rate us highly — and clients stay with us",
      duration: 13,
      template: "rating",
      cue: {
        stars: 5,
        starsLabel: "4.7 / 5 PATIENT RATING",
        barLabel: "CLIENTS WHO STAY",
        barPct: 96,
        barValue: "96%",
        barNote: "100+ partners renew, year on year",
      },
      tilt: 1,
      focus: ["satisfaction", "retention"],
      evidence: "quality",
      evidenceLabel: "Quality & Retention",
      script:
        "But speed alone isn't care. Our patients rate us four point seven out of five, complaints stay rare — and ninety-six percent of the clients who choose us, stay with us. Don't take our word for it; their words are on file.",
    },
    {
      key: "finance",
      name: "Finance",
      title: "No surprises on the invoice",
      subtitle: "Accurate, fast, and fully auditable billing",
      duration: 11,
      template: "invoice",
      cue: {
        header: "INVOICE · CMA-2026",
        badge: "99.2% ACCURATE",
        lines: 3,
        note: "submitted fast · disputes almost never",
      },
      tilt: 1.6,
      focus: ["invoice"],
      evidence: "finance",
      evidenceLabel: "Billing & Finance",
      script:
        "And when the invoice lands on your desk, there are no surprises — over ninety-nine percent accurate, submitted fast, disputes almost never. Clean, transparent, fully auditable.",
    },
    {
      key: "proof",
      name: "Proof",
      title: "This is the job",
      subtitle: "A real critical case — and where we’re headed next",
      duration: 18,
      template: "route",
      cue: {
        from: "Remote incident",
        to: "Critical care · in time",
        chips: ["Technology", "Automation", "Reporting"],
      },
      tilt: -1.4,
      focus: [],
      evidence: "proof",
      evidenceLabel: "Case Proof & Roadmap",
      script:
        "Last year, a traveller collapsed in a remote region with no hospital for hundreds of miles. Within hours we'd coordinated a medical evacuation across borders and got them to critical care in time. That's not a statistic — that's the job. And we're building to do it even better: smarter technology, automation, richer reporting for you. Everything you've seen is backed by evidence — please, take a look.",
    },
  ];

  for (const [i, s] of SCENES.entries()) {
    await db.insert(schema.scenes).values({
      orgId: org.id,
      presentationId: presentation.id,
      position: i,
      name: s.name,
      intent: s.title,
      templateId: templateIds[s.template],
      templateParams: {
        sceneKey: s.key,
        tilt: s.tilt,
        evidenceLabel: s.evidenceLabel,
        cue: s.cue,
      },
      title: s.title,
      subtitle: s.subtitle,
      script: s.script,
      scriptWordCount: s.script.split(/\s+/).length,
      estSeconds: s.duration,
      metricIds: s.focus.map((k) => metricIds[k]),
      documentIds: docIds[s.evidence],
      readiness: "ready",
    });
  }
  console.log(`scenes: ${SCENES.length}`);

  // ── 7. Share links ──────────────────────────────────────────────────────────

  await db.insert(schema.shareLinks).values([
    {
      orgId: org.id,
      presentationId: presentation.id,
      code: null,
      isDefault: true,
      status: "live",
    },
    {
      orgId: org.id,
      presentationId: presentation.id,
      code: "k4f7q2",
      isDefault: false,
      recipientName: "Meridian Insurance Group",
      status: "live",
    },
  ]);
  console.log("share links: /p/credible-en (default) · /p/credible-en-k4f7q2 (Meridian)");
  console.log("\nseed complete ✓");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
