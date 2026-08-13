/** Lowercase, hyphenate, strip to [a-z0-9-], collapse repeats, cap 60 chars. Empty in → empty out. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
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

/** Slug falls back from page title → hostname → 'capture'. */
export function captureBasename(title: string, url: string | undefined, date: Date): string {
  const slug = slugify(title) || slugify(hostnameOf(url)) || 'capture';
  return `${slug}_${timestampForFilename(date)}`;
}
