/** Lowercase, hyphenate, strip to [a-z0-9-], collapse repeats, cap 60 chars. Empty in → empty out. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Typographic punctuation common in page titles: em/en dashes as in
    // "Chateau Chloe - The Rooms", curly quotes, primes, "Section: Name",
    // path separators. The catch-all below folds these anyway; they are
    // explicit so the intent survives future edits.
    .replace(/[\u2010-\u2015\u2018\u2019\u201c\u201d\u2032\u2033:|/\\]+/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function hostnameOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local time, filename-safe: YYYY-MM-DD_HH-mm */
export function timestampForFilename(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

/** Local time with seconds, filename-safe: YYYY-MM-DD_HH-mm-ss */
export function timestampWithSeconds(date: Date): string {
  return `${timestampForFilename(date)}-${pad(date.getSeconds())}`;
}

// The last stem handed out, so two captures in the same second still get
// different names. Without this the second file was renamed "(1)" on disk
// while latest.md still named the first one (NOBC-363).
let lastStem = '';
let lastStemCount = 0;

/** Pure form of the counter, for tests: the stem to use after `previous` was used `count` times. */
export function nextUniqueStem(stem: string, previous: string, count: number): { name: string; count: number } {
  if (stem !== previous) return { name: stem, count: 1 };
  return { name: `${stem}-${count + 1}`, count: count + 1 };
}

/** Slug falls back from page title → hostname → 'capture'. Unique per capture, to the second. */
export function captureBasename(title: string, url: string | undefined, date: Date): string {
  const slug = slugify(title) || slugify(hostnameOf(url)) || 'capture';
  const stem = `${slug}_${timestampWithSeconds(date)}`;
  const next = nextUniqueStem(stem, lastStem, lastStemCount);
  lastStem = stem;
  lastStemCount = next.count;
  return next.name;
}
