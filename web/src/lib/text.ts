/** Lowercase, strip Latin diacritics and Arabic tashkeel, unify alef/yeh/teh-marbuta forms. */
export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[آأإ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
}

export function matchesQuery(title: string, query: string): boolean {
  if (!query) return true
  const t = normalizeForSearch(title)
  return query.split(" ").every((w) => t.includes(w))
}
