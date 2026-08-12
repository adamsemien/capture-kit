export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'capture';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local time, filename-safe: YYYY-MM-DD_HH-mm */
export function timestampForFilename(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

export function captureBasename(title: string, date: Date): string {
  return `${slugify(title)}_${timestampForFilename(date)}`;
}
