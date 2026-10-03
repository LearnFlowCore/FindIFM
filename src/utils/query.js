// Разбор произвольного запроса и подготовка операторов Яндекса.
const { extractDate, resolveDateRange } = require('./date');
const { splitRules } = require('./domain');

function normalizeText(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function parseQuery(input = {}) {
  const original = String(input.query || input.original || '').trim();
  if (!original) throw new Error('Введите поисковый запрос.');
  const matchMode = ['exact', 'all', 'strict', 'any'].includes(input.matchMode) ? input.matchMode : input.exactPhrase ? 'exact' : 'all';
  const exactPhrase = matchMode === 'exact';
  const extracted = exactPhrase ? { date: null, match: null } : extractDate(original);
  const searchText = extracted.match ? original.replace(extracted.match, ' ').replace(/\s+/g, ' ').trim() : original;
  if (!searchText) throw new Error('После извлечения даты поисковый запрос оказался пустым.');
  const range = resolveDateRange({
    period: input.period || null, from: input.from || null, to: input.to || null, extractedDate: extracted.date,
  });
  const normalized = normalizeText(searchText);
  const acronyms = searchText.split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 1 && token.length <= 5 && /\p{L}/u.test(token) && token === token.toLocaleUpperCase('ru-RU'))
    .map(normalizeText);
  const list = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\n,]+/)).map(normalizeText).filter(Boolean))];
  const minTextLength = Number(input.minTextLength || 0);
  const maxTextLength = Number(input.maxTextLength || 0);
  if (![minTextLength, maxTextLength].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000)) throw new Error('Укажите допустимую длину текста.');
  if (maxTextLength && minTextLength > maxTextLength) throw new Error('Минимальная длина текста не может быть больше максимальной.');
  const deepPages = input.deepPages === undefined ? 12 : Number(input.deepPages);
  if (!Number.isSafeInteger(deepPages) || deepPages < 0 || deepPages > 30) throw new Error('Глубина обхода сайта должна быть от 0 до 30 страниц.');
  return {
    original, text: searchText, normalized, exactPhrase, matchMode,
    words: [...new Set(normalized.split(' ').filter(Boolean))],
    acronyms: [...new Set(acronyms)],
    extractedDate: extracted.date, period: input.period || null, ...range,
    whitelist: splitRules(input.whitelist), blacklist: splitRules(input.blacklist),
    includeKeywords: list(input.includeKeywords), excludeKeywords: list(input.excludeKeywords),
    category: normalizeText(input.category), minTextLength, maxTextLength,
    media: ['present', 'absent'].includes(input.media) ? input.media : 'any',
    deduplicate: input.deduplicate !== false, deepPages, quickTest: input.quickTest === true,
  };
}

function buildYandexText(query) {
  const phrase = query.exactPhrase ? `"${query.text.replace(/"/g, '')}"`
    : query.matchMode === 'any' ? `(${query.words.join(' | ')})` : query.text;
  const allow = query.whitelist.length ? ` (${query.whitelist.map(rule => `site:${rule.replace(/^=/, '')}`).join(' | ')})` : '';
  const deny = query.blacklist.map(rule => ` -site:${rule.replace(/^=/, '')}`).join('');
  return `${phrase}${allow}${deny}`.trim();
}

function textMatches(text, query) {
  const normalized = normalizeText(text);
  if (query.exactPhrase) return (` ${normalized} `).includes(` ${query.normalized} `);
  const tokens = normalized.split(' ').filter(Boolean);
  const matches = word => {
    if ((query.acronyms || []).includes(word)) return tokens.includes(word);
    if (query.matchMode === 'strict') return tokens.includes(word);
    if (word.length < 5) return tokens.includes(word);
    const stem = word.slice(0, -2);
    return tokens.some(token => token.length >= 5 && (token.startsWith(stem) || word.startsWith(token.slice(0, -2))));
  };
  return query.matchMode === 'any' ? query.words.some(matches) : query.words.every(matches);
}

module.exports = { parseQuery, buildYandexText, normalizeText, textMatches };
