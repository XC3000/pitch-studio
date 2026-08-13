/**
 * Human-readable documentation for each built-in cue template's params — the
 * single source of truth for "what goes where" in a cue's JSON. Consumed by the
 * Scene Builder cue editor (field hints + "Insert example") so a template can be
 * filled in by hand, and kept in lockstep with the components in `cues.tsx`.
 *
 * When you add/change a cue in cues.tsx, update its entry here too.
 */

export type CueField = {
  /** JSON key inside the cue object. */
  name: string;
  /** short type hint shown to the user, e.g. "string", "number", "{ value, label }[]". */
  type: string;
  /** what it controls and where it appears on stage. */
  desc: string;
  /** false/omitted → optional (has a sensible default). */
  required?: boolean;
};

export type CueSchema = {
  /** one-line description of the visual + when to use it. */
  summary: string;
  fields: CueField[];
  /** a ready-to-use, valid cue object (the "Insert example" payload). */
  example: Record<string, unknown>;
};

export const CUE_SCHEMAS: Record<string, CueSchema> = {
  pillars: {
    summary: "A row of value/label chips — a company intro or a set of headline facts.",
    fields: [
      {
        name: "items",
        type: "{ value, label }[]",
        desc: "One chip each (use 3-4). `value` is the big blue headline; `label` is the small caption beneath it.",
        required: true,
      },
    ],
    example: {
      items: [
        { value: "24/7", label: "ALWAYS ON" },
        { value: "340+", label: "HOSPITALS" },
        { value: "12 yrs", label: "EXPERIENCE" },
      ],
    },
  },

  journey: {
    summary: "A horizontal timeline with a traveling dot — a process or lifecycle.",
    fields: [
      {
        name: "stages",
        type: "{ title, sub, done? }[]",
        desc: "Each node on the line. `title` is the bold step name, `sub` the small caption. Set `done: true` on the final stage to turn it green.",
        required: true,
      },
    ],
    example: {
      stages: [
        { title: "First call", sub: "member reaches us" },
        { title: "Triage", sub: "assess & route" },
        { title: "Care", sub: "treated in-network" },
        { title: "Resolved", sub: "case closed", done: true },
      ],
    },
  },

  "network-map": {
    summary: "Pinging pins over a faint map — geographic reach or coverage. Renders fine with no params.",
    fields: [
      {
        name: "pins",
        type: "{ x, y, size, quiet? }[]",
        desc: "Optional. Pin positions as % of the frame — `x`/`y` are 0-100, `size` is the dot diameter in px, `quiet: true` drops the pulsing ring. Omit to use the built-in layout.",
      },
    ],
    example: {
      pins: [
        { x: 18, y: 24, size: 9 },
        { x: 44, y: 16, size: 8 },
        { x: 68, y: 26, size: 9 },
        { x: 83, y: 52, size: 7, quiet: true },
      ],
    },
  },

  "gop-doc": {
    summary: "An approval-document card with a live clock — a speed / turnaround proof point.",
    fields: [
      { name: "clock", type: "string", desc: 'The big number left of the document, e.g. "00:47".' },
      { name: "clockLabel", type: "string", desc: 'Caption under the clock, e.g. "AVG GOP TIME".' },
      { name: "docHeader", type: "string", desc: "Header text inside the document card." },
      { name: "approvedLabel", type: "string", desc: 'Green status line, e.g. "✓ APPROVED".' },
      { name: "stamp", type: "[string, string]", desc: 'Two short lines inside the round stamp, e.g. ["CMA", "GOP"].' },
    ],
    example: {
      clock: "00:47",
      clockLabel: "AVG GOP TIME",
      docHeader: "GUARANTEE OF PAYMENT",
      approvedLabel: "✓ APPROVED",
      stamp: ["CMA", "GOP"],
    },
  },

  rating: {
    summary: "Filling stars + a retention bar — satisfaction or loyalty metrics.",
    fields: [
      { name: "stars", type: "number", desc: "How many filled stars to show (1-5)." },
      { name: "starsLabel", type: "string", desc: 'Caption under the stars, e.g. "4.7 / 5 PATIENT RATING".' },
      { name: "barLabel", type: "string", desc: "Label on the left of the bar." },
      { name: "barPct", type: "number", desc: "Bar fill, 0-100." },
      { name: "barValue", type: "string", desc: 'Value shown on the right of the bar, e.g. "96%".' },
      { name: "barNote", type: "string", desc: "Small note under the bar." },
    ],
    example: {
      stars: 5,
      starsLabel: "4.7 / 5 PATIENT RATING",
      barLabel: "CLIENTS WHO STAY",
      barPct: 96,
      barValue: "96%",
      barNote: "100+ partners renew",
    },
  },

  invoice: {
    summary: "An invoice card whose line items check off — a billing accuracy proof point.",
    fields: [
      { name: "header", type: "string", desc: 'Monospace header, e.g. "INVOICE · CMA-2026".' },
      { name: "badge", type: "string", desc: 'Green badge top-right, e.g. "99.2% ACCURATE".' },
      { name: "lines", type: "number", desc: "How many checkmark line items to draw." },
      { name: "note", type: "string", desc: "Small note under the line items." },
    ],
    example: {
      header: "INVOICE · CMA-2026",
      badge: "99.2% ACCURATE",
      lines: 3,
      note: "submitted fast · disputes almost never",
    },
  },

  route: {
    summary: "A cross-border route with a traveling plane + tag chips — a case story or logistics.",
    fields: [
      { name: "from", type: "string", desc: 'Red start label on the left, e.g. "Remote incident".' },
      { name: "to", type: "string", desc: 'Green end label on the right, e.g. "Critical care · in time".' },
      { name: "chips", type: "string[]", desc: 'Pill tags under the route, e.g. ["Technology", "Automation"].' },
    ],
    example: {
      from: "Remote incident",
      to: "Critical care · in time",
      chips: ["Technology", "Automation", "Reporting"],
    },
  },
};
