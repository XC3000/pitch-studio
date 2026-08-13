"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { ActionError, safeAction } from "@/lib/safe-action";
import { slugify } from "@/lib/slug";
import type { MetricFormat } from "@/viewer/types";

export type MetricInput = {
  id?: string;
  key: string;
  label: string;
  sublabel: string;
  rawValue: string; // numeric string, or "" for literal-only metrics
  format: MetricFormat;
};

/** Normalize a key to a stable, url-safe identifier used by scenes' metricIds. */
function metricKey(raw: string): string {
  return slugify(raw).replace(/-/g, "_").slice(0, 40);
}

export async function saveMetric(orgSlug: string, input: MetricInput): Promise<ActionResult> {
  return safeAction("saveMetric", async () => {
    const { org } = await requireOrg(orgSlug);
    const label = input.label.trim();
    if (!label) throw new ActionError("Label is required");
    const key = metricKey(input.key || label);
    if (!key) throw new ActionError("Couldn't derive a key from the label");
    const scope = forOrg(org.id);
    const rawValue = input.rawValue.trim() === "" ? null : input.rawValue.trim();
    if (rawValue !== null && Number.isNaN(Number(rawValue))) {
      throw new ActionError("Value must be a number (or blank for a literal metric)");
    }
    const sublabel = input.sublabel.trim() || null;

    if (input.id) {
      const updated = await scope.db
        .update(schema.metricLibraryItems)
        .set({ key, label, sublabel, rawValue, format: input.format })
        .where(scope.own(schema.metricLibraryItems, eq(schema.metricLibraryItems.id, input.id)))
        .returning({ id: schema.metricLibraryItems.id });
      if (updated.length === 0) throw new ActionError("Metric not found");
    } else {
      try {
        await scope.db
          .insert(schema.metricLibraryItems)
          .values(scope.stamp({ key, label, sublabel, rawValue, format: input.format }));
      } catch {
        throw new ActionError(`A metric with key "${key}" already exists`);
      }
    }
    revalidatePath(`/o/${orgSlug}/metrics`);
  });
}

export async function deleteMetric(orgSlug: string, id: string): Promise<ActionResult> {
  return safeAction("deleteMetric", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    await scope.db
      .delete(schema.metricLibraryItems)
      .where(scope.own(schema.metricLibraryItems, eq(schema.metricLibraryItems.id, id)));
    revalidatePath(`/o/${orgSlug}/metrics`);
  });
}
