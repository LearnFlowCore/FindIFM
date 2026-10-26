// Извлечение русских дат и расчёт диапазона по установленному приоритету.
const MONTHS = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};
const MONTHS_SHORT = {
  янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, июн: 6, июл: 7, авг: 8, сен: 9, сент: 9, окт: 10, ноя: 11, дек: 12,
};
const PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const WITHIN = { day: '1', week: '77', month: '87', year: '367' };
const RELATIVE_DAYS = [['позавчера', -2], ['вчера', -1], ['сегодня', 0]];
const MONTH_WORDS = 'январ[я]?|феврал[я]?|марта?|апрел[я]?|мая|июн[я]?|июл[я]?|августа?|сентябр[я]?|октябр[я]?|ноябр[я]?|декабр[я]?|янв\\.?|фев\\.?|мар\\.?|апр\\.?|июн\\.?|июл\\.?|авг\\.?|сен\\.?|сент\\.?|окт\\.?|ноя\\.?|дек\\.?';
const pad = value => String(value).padStart(2, '0');

function isoDate(year, month, day) {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? `${year}-${pad(month)}-${pad(day)}` : null;
}

function monthNumber(word) {
  const normalized = String(word || '').toLowerCase().replace(/\.$/, '');
  return MONTHS[normalized] || MONTHS_SHORT[normalized.slice(0, 4)] || MONTHS_SHORT[normalized.slice(0, 3)] || null;
}

function relativeIso(now, days) {
  const value = new Date(now);
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function extractDate(text, now = new Date()) {
  const value = String(text || '');
  // 15.03.2024, 15/03/2024
  let match = value.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (match) return { date: isoDate(+match[3], +match[2], +match[1]), match: match[0] };
  // 2024-03-15, 2024/03/15 и дата в пути ссылки /2024/03/15/
  match = value.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (match) return { date: isoDate(+match[1], +match[2], +match[3]), match: match[0] };
  // 15 марта 2024, 15 мар 2024, 15 мар. 2024
  match = value.toLowerCase().match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_WORDS})[а-я.]*\\s+(\\d{4})\\b`));
  if (match) {
    const month = monthNumber(match[2]);
    if (month) return { date: isoDate(+match[3], month, +match[1]), match: match[0] };
  }
  const lower = value.toLowerCase();
  const boundary = '(?<![\\p{L}\\p{N}])';
  const endBoundary = '(?![\\p{L}\\p{N}])';
  for (const [word, offset] of RELATIVE_DAYS) {
    if (new RegExp(`${boundary}${word}${endBoundary}`, 'u').test(lower)) return { date: relativeIso(now, offset), match: word };
  }
  // 3 дня назад, 2 недели назад, 5 месяцев назад, 1 год назад
  match = lower.match(new RegExp(`${boundary}(\\d{1,2})\\s+(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)\\s+назад${endBoundary}`, 'u'));
  if (match) {
    const count = +match[1];
    const unit = match[2];
    const days = /день|дня|дней/.test(unit) ? count
      : /недел/.test(unit) ? count * 7
        : /месяц/.test(unit) ? count * 30 : count * 365;
    return { date: relativeIso(now, -days), match: match[0] };
  }
  match = lower.match(new RegExp(`${boundary}(неделю|месяц|год)\\s+назад${endBoundary}`, 'u'));
  if (match) {
    const days = match[1] === 'неделю' ? 7 : match[1] === 'месяц' ? 30 : 365;
    return { date: relativeIso(now, -days), match: match[0] };
  }
  return { date: null, match: null };
}

function parseDate(text) { return extractDate(text).date; }
// Для таблиц и выгрузок: только проверенная календарная дата.
function formatDate(value) {
  const date = parseDate(value);
  if (!date) return '';
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}
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

module.exports = { MONTHS, MONTHS_SHORT, PERIOD_DAYS, WITHIN, extractDate, parseDate, formatDate, resolveDateRange, shift };
