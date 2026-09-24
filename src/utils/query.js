// Разбор произвольного запроса и подготовка операторов Яндекса.
const { extractDate, resolveDateRange } = require('./date');
const { splitRules } = require('./domain');

function normalizeText(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function parseQuery(input = {}) {
  const original = String(input.query || input.original || '').trim();
  if (!original) throw new Error('Введите поисковый запрос.');
  const exactPhrase = Boolean(input.exactPhrase);
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
  return {
    original, text: searchText, normalized, exactPhrase,
    words: [...new Set(normalized.split(' ').filter(Boolean))],
    acronyms: [...new Set(acronyms)],
    extractedDate: extracted.date, period: input.period || null, ...range,
    whitelist: splitRules(input.whitelist), blacklist: splitRules(input.blacklist),
    deduplicate: input.deduplicate !== false,
  };
}

function buildYandexText(query) {
  const phrase = query.exactPhrase ? `"${query.text.replace(/"/g, '')}"` : query.text;
  const allow = query.whitelist.length ? ` (${query.whitelist.map(rule => `site:${rule.replace(/^=/, '')}`).join(' | ')})` : '';
  const deny = query.blacklist.map(rule => ` -site:${rule.replace(/^=/, '')}`).join('');
  return `${phrase}${allow}${deny}`.trim();
}

function textMatches(text, query) {
  const normalized = normalizeText(text);
  if (query.exactPhrase) return normalized.includes(query.normalized);
  const tokens = normalized.split(' ').filter(Boolean);
  return query.words.every(word => {
    if ((query.acronyms || []).includes(word)) return tokens.includes(word);
    if (word.length < 5) return tokens.includes(word);
    const stem = word.slice(0, -2);
    return tokens.some(token => token.length >= 5 && (token.startsWith(stem) || word.startsWith(token.slice(0, -2))));
  });
}

module.exports = { parseQuery, buildYandexText, normalizeText, textMatches };
