import type { MetricFormat } from "./types";

/**
 * One formatter for metric values everywhere (viewer cards, count-ups; later
 * the builder and generated scripts). `frac` scales the value for count-up
 * animation — 1 renders the final figure.
 */
export function formatMetric(format: MetricFormat, value: number | null, frac = 1): string {
  const v = (value ?? 0) * frac;
  switch (format.style) {
    case "literal":
      return format.text;
    case "number":
      return (
        (format.decimals ? v.toFixed(format.decimals) : Math.round(v).toLocaleString("en-US")) +
        (format.suffix ?? "")
      );
    case "percent":
      return v.toFixed(format.decimals ?? 0) + "%";
    case "rating":
      return v.toFixed(format.decimals ?? 1) + "/" + (format.outOf ?? 5);
    case "duration":
      return (format.prefix ?? "") + Math.round(v) + (format.unit ? " " + format.unit : "");
  }
}
