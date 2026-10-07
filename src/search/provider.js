// Заменяемый интерфейс поиска: HTML через CDP сейчас, Search API в будущем.
const { normalizeUrl } = require('../utils/url');
const { domainAllowed } = require('../utils/domain');
const { parseDate } = require('../utils/date');
const { buildYandexText, textMatches } = require('../utils/query');
const { classifySentiment } = require('../utils/sentiment');

class SearchProvider { async search() { throw new Error('SearchProvider.search должен быть реализован'); } }
class YandexAPIProvider extends SearchProvider { async search() { throw new Error('Yandex Search API пока не настроен'); } }

function inRange(date, query) { return !date || ((!query.from || date >= query.from) && (!query.to || date <= query.to)); }
function scoreDeepLink(url, query) {
  // Browser.inspect currently provides URL strings, not anchor text or titles.
  let source;
  try { source = decodeURI(url); } catch { source = url; }
  source = source.toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]+/gu, ' ');
  let score = 0;
  for (const word of query.words || []) if (source.includes(word)) score += 2;
  for (const word of query.includeKeywords || []) if (source.includes(word)) score += 3;
  if (query.exactPhrase && query.normalized && source.includes(query.normalized)) score += 5;
  return score;
}
function passesContentFilters(page, query) {
  const text = String(page.text || '').toLocaleLowerCase('ru-RU');
  if (query.includeKeywords?.some(word => !text.includes(word))) return false;
  if (query.excludeKeywords?.some(word => text.includes(word))) return false;
  if (query.category && !String(page.category || '').toLocaleLowerCase('ru-RU').includes(query.category)) return false;
  const length = Number(page.textLength ?? text.length);
  if (query.minTextLength && length < query.minTextLength) return false;
  if (query.maxTextLength && length > query.maxTextLength) return false;
  if (query.media === 'present' && !page.hasMedia) return false;
  if (query.media === 'absent' && page.hasMedia) return false;
  if (query.sentiment && query.sentiment !== 'any' && (page.sentiment || classifySentiment(`${page.title || ''} ${page.text || ''} ${page.description || ''}`)) !== query.sentiment) return false;
  return true;
}

class YandexHTMLProvider extends SearchProvider {
  constructor(browser, logger) { super(); this.browser = browser; this.log = logger; }
  async search(query, settings, hooks = {}) {
    const deadline = settings.deadlineAt || Date.now() + Math.max(1, Number(settings.maxDurationMinutes) || 30) * 60000;
    query.yandexText = buildYandexText(query);
    let raw, pausedCaptcha = false;
    try { raw = await this.browser.collect(query, settings, hooks); }
    catch (error) {
      if (error.code !== 'CAPTCHA_TIMEOUT') throw error;
      raw = error.partialSearchRows || [];
      pausedCaptcha = true;
    }
    const inspectionDeadline = pausedCaptcha ? Date.now() + 5 * 60000 : deadline;
    const candidates = [], seen = new Set(), candidateUrls = new Set(), visited = new Set(); let withinDuplicates = 0, skipped = 0;
    const deep = { rootInspected: 0, deepLinksFound: 0, deepLinksSelected: 0, deepPagesInspected: 0, deepAccepted: 0 };
    const maxResults = Number(settings.maxResults) || 500;
    const maxDeepPages = Number(settings.maxDeepPages ?? 4);
    const maxSitePages = Math.min(query.deepPages ?? 12, Number.isFinite(maxDeepPages) ? Math.max(0, Math.floor(maxDeepPages)) : 4, 12);
    const maxInspections = Math.min(300, Math.max(30, raw.length * (maxSitePages + 1)));
    let inspected = 0;
    for (const item of raw) {
      if (hooks.isCancelled?.()) break;
      if (candidates.length >= maxResults || Date.now() >= inspectionDeadline || inspected >= maxInspections) break;
      const normalized = normalizeUrl(item.url);
      if (!normalized || /(^|\.)yandex\.(ru|com)$/i.test(new URL(normalized).hostname)) { skipped += 1; continue; }
      if (seen.has(normalized)) { withinDuplicates += 1; skipped += 1; continue; }
      seen.add(normalized);
      if (!domainAllowed(normalized, query.whitelist, query.blacklist)) { skipped += 1; continue; }
      const hostname = new URL(normalized).hostname;
      const pending = [{ url: item.url, depth: 0 }];
      let sitePages = 0;
      while (pending.length && candidates.length < maxResults && inspected < maxInspections && Date.now() < inspectionDeadline) {
        if (hooks.isCancelled?.()) break;
        const entry = pending.shift();
        const url = normalizeUrl(entry.url);
        if (!url || visited.has(url) || new URL(url).hostname !== hostname || !domainAllowed(url, query.whitelist, query.blacklist)) { skipped += 1; continue; }
        if (/\.(?:pdf|jpe?g|png|gif|webp|svg|mp[34]|zip|rar|docx?|xlsx?)(?:\?|$)/i.test(url)) { skipped += 1; continue; }
        visited.add(url); inspected += 1;
        if (entry.depth) deep.deepPagesInspected += 1;
        else deep.rootInspected += 1;
        const snippetMatch = entry.depth === 0 && textMatches(`${item.title} ${item.snippet}`, query);
        try {
           const page = await this.browser.inspect(url, query, settings);
           page.sentiment = classifySentiment(`${page.title || ''} ${page.text || ''} ${page.description || ''}`);
          let matched = false;
          if ((query.semantic || textMatches(`${page.title} ${page.text}`, query)) && passesContentFilters(page, query)) {
            const date = parseDate(page.dateText) || (entry.depth === 0 ? parseDate(item.dateText) : null) || parseDate(url);
            if ((!query.extractedDate || date) && inRange(date, query) && !candidateUrls.has(url)) {
              candidateUrls.add(url);
              candidates.push({ ...item, ...page, url: entry.url, date, normalized: url, snippetMatch, description: page.description || item.snippet });
              if (entry.depth) deep.deepAccepted += 1;
              hooks.onCandidate?.(candidates[candidates.length - 1]);
              matched = true;
            }
          }
          // Scan linked pages even when the landing page itself does not match.
          if (entry.depth < 2 && maxSitePages) {
             const links = (page.links || []).map((link, index) => ({ url: normalizeUrl(link), original: link, index }))
               .filter(link => link.url && /^https?:\/\//i.test(link.original) && new URL(link.url).hostname === hostname && !visited.has(link.url))
               .sort((a, b) => scoreDeepLink(b.url, query) - scoreDeepLink(a.url, query) || a.index - b.index);
             deep.deepLinksFound += links.length;
             for (const link of links) {
               if (sitePages >= maxSitePages) break;
               if (pending.some(next => normalizeUrl(next.url) === link.url)) continue;
               pending.push({ url: link.original, depth: entry.depth + 1 }); sitePages += 1; deep.deepLinksSelected += 1;
            }
          }
          hooks.onSitePage?.(inspected, url, candidates.length, matched);
        } catch (error) {
          hooks.onSiteError?.(url, error.message);
          this.log.warn({ url, error: error.message }, 'Не удалось загрузить найденную страницу');
           if (entry.depth !== 0 || (!query.semantic && !snippetMatch) || query.category || query.minTextLength || query.maxTextLength || query.media !== 'any' || query.sentiment !== 'any' || query.includeKeywords?.length || query.excludeKeywords?.length) continue;
          const date = parseDate(item.dateText);
          if ((query.extractedDate && !date) || !inRange(date, query) || candidateUrls.has(url)) continue;
          candidateUrls.add(url);
          candidates.push({ ...item, date, normalized: url, description: String(item.snippet || '').slice(0, 300), snippetMatch: true });
          hooks.onCandidate?.(candidates[candidates.length - 1]);
        }
      }
    }
    const stats = { found: raw.length, duplicates: withinDuplicates, inspected, skipped, accepted: candidates.length, ...deep };
    this.log.info?.(stats, 'Итог проверки поисковых ссылок');
    hooks.onSearchStats?.(stats);
    return { candidates, withinDuplicates, pausedCaptcha };
  }
}
module.exports = { SearchProvider, YandexHTMLProvider, YandexAPIProvider, inRange, passesContentFilters };
