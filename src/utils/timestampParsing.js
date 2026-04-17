export function createStrictDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const hh = Number(hour);
  const mm = Number(minute);
  const ss = Number(second);

  if (![y, m, d, hh, mm, ss].every((value) => Number.isFinite(value))) {
    return new Date(Number.NaN);
  }

  if (m < 1 || m > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) {
    return new Date(Number.NaN);
  }

  const date = new Date(y, m - 1, d, hh, mm, ss, 0);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d ||
    date.getHours() !== hh ||
    date.getMinutes() !== mm ||
    date.getSeconds() !== ss
  ) {
    return new Date(Number.NaN);
  }

  return date;
}

export function parseTimestampValue(value) {
  const text = String(value || '').trim();
  if (!text) return new Date(Number.NaN);

  // Native parsing for explicit ISO strings with timezone support.
  if (text.includes('T') || /[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const iso = new Date(text);
    if (!Number.isNaN(iso.getTime())) return iso;
  }

  const normalized = text.replace(/\s+/g, ' ');
  let match = normalized.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return createStrictDate(match[3], match[2], match[1], match[4] ?? 0, match[5] ?? 0, match[6] ?? 0);
  }

  match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return createStrictDate(match[1], match[2], match[3], match[4] ?? 0, match[5] ?? 0, match[6] ?? 0);
  }

  match = normalized.match(/^(\d{4})\/(\d{2})\/(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return createStrictDate(match[1], match[2], match[3], match[4] ?? 0, match[5] ?? 0, match[6] ?? 0);
  }

  const fallback = new Date(text);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  return new Date(Number.NaN);
}
