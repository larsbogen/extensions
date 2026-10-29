export function normalize(value) {
  return String(value ?? "")
    .toLocaleLowerCase("nb")
    .replaceAll("æ", "ae")
    .replaceAll("ø", "o")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const collator = new Intl.Collator("nb", {
  sensitivity: "base",
  numeric: true,
});

export function indexEntries(entries, topics = []) {
  const labels = new Map(topics.map((t) => [t.id, t.label]));
  return entries.map((entry) => ({
    ...entry,
    _search: {
      title: normalize(entry.title),
      authors: normalize(entry.authors.join(" ")),
      year: String(entry.year),
      supervisors: normalize(entry.supervisors.join(" ")),
      keywords: normalize(entry.keywords.join(" ")),
      abstract: normalize(entry.abstract),
      tags: normalize(
        (entry.tags || []).map((id) => labels.get(id) || "").join(" "),
      ),
    },
  }));
}

export function findEntries(
  entries,
  { q = "", year = "", sort = "", tags = [] } = {},
  fulltext = {},
) {
  const terms = normalize(q).split(" ").filter(Boolean);
  const matches = [];
  for (const entry of entries) {
    if (year && String(entry.year) !== String(year)) continue;
    if (!tags.every((tag) => (entry.tags || []).includes(tag))) continue;
    let score = 0;
    let found = true;
    for (const term of terms) {
      let best = 0;
      for (const [field, weight] of [
        ["title", 12],
        ["authors", 9],
        ["year", 8],
        ["keywords", 6],
        ["tags", 6],
        ["supervisors", 3],
        ["abstract", 1],
      ]) {
        if (entry._search[field].includes(term))
          best = Math.max(
            best,
            weight +
              (field === "title" && entry._search.title.startsWith(term)
                ? 4
                : 0),
          );
      }
      if (!best && fulltext[entry.id]?.terms?.includes(term)) best = 0.5;
      if (!best) {
        found = false;
        break;
      }
      score += best;
    }
    if (found) matches.push({ entry, score });
  }
  const selectedSort = sort || (terms.length ? "relevance" : "newest");
  matches.sort((a, b) => {
    if (selectedSort === "relevance" && a.score !== b.score)
      return b.score - a.score;
    if (selectedSort === "oldest" && a.entry.year !== b.entry.year)
      return a.entry.year - b.entry.year;
    if (selectedSort === "title")
      return (
        collator.compare(a.entry.title, b.entry.title) ||
        a.entry.id.localeCompare(b.entry.id)
      );
    if (selectedSort === "author")
      return (
        collator.compare(a.entry.authors[0] || "", b.entry.authors[0] || "") ||
        collator.compare(a.entry.title, b.entry.title)
      );
    return (
      b.entry.year - a.entry.year ||
      collator.compare(a.entry.title, b.entry.title) ||
      a.entry.id.localeCompare(b.entry.id)
    );
  });
  return matches.map((x) => x.entry);
}

export function countTopics(entries, topics, state = {}, fulltext = {}) {
  const matches = findEntries(entries, state, fulltext);
  return new Map(
    topics.map((topic) => [
      topic.id,
      matches.filter((entry) => (entry.tags || []).includes(topic.id)).length,
    ]),
  );
}
