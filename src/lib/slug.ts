/** Shared slug/code helpers for presentations and share links. */

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Short, url-safe, unambiguous share-link code (no vowels/lookalikes). */
export function shareCode(len = 6): string {
  const alphabet = "23456789bcdfghjkmnpqrstvwxz";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
