// Извлечение русских дат и расчёт диапазона по установленному приоритету.
const MONTHS = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};
const PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const WITHIN = { day: '1', week: '77', month: '87', year: '367' };
const pad = value => String(value).padStart(2, '0');

function isoDate(year, month, day) {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? `${year}-${pad(month)}-${pad(day)}` : null;
}

function extractDate(text) {
  const value = String(text || '');
  let match = value.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  if (match) return { date: isoDate(+match[3], +match[2], +match[1]), match: match[0] };
  match = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (match) return { date: isoDate(+match[1], +match[2], +match[3]), match: match[0] };
  match = value.toLowerCase().match(/\b(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\b/);
  if (match) return { date: isoDate(+match[3], MONTHS[match[2]], +match[1]), match: match[0] };
  return { date: null, match: null };
}

function parseDate(text) { return extractDate(text).date; }
function shift(iso, days) { const value = new Date(`${iso}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }

function resolveDateRange({ period, from, to, extractedDate }, now = new Date()) {
  if (from || to) {
    const normalizedFrom = parseDate(from); const normalizedTo = parseDate(to);
    if (!normalizedFrom || !normalizedTo || normalizedFrom > normalizedTo) throw new Error('Укажите корректный ручной диапазон дат.');
    return { from: normalizedFrom, to: normalizedTo, within: null };
  }
  if (extractedDate) {
    const radius = PERIOD_DAYS[period] || 0;
    return { from: shift(extractedDate, -radius), to: shift(extractedDate, radius), within: null };
  }
  if (PERIOD_DAYS[period]) return { from: null, to: null, within: WITHIN[period] };
  return { from: null, to: null, within: null };
}

module.exports = { MONTHS, PERIOD_DAYS, WITHIN, extractDate, parseDate, resolveDateRange, shift };
