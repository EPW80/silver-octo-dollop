const TOKEN = /[\p{L}\p{N}]+/gu;

/** Words of at least two characters, lowercased, in order. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN) ?? []).filter((term) => term.length > 1);
}

/**
 * Build an FTS5 MATCH expression from user text.
 * Terms are quoted and searched as prefixes so "run" still hits "running"
 * after the porter stemmer. Returns null when nothing searchable remains.
 */
export function toFtsQuery(query: string): string | null {
  const terms = [...new Set(tokenize(query))].slice(0, 16);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" OR ");
}

export function preview(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 3)}...`;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
