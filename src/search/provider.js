// Заменяемый интерфейс поиска: HTML через CDP сейчас, Search API в будущем.
const { normalizeUrl } = require('../utils/url');
const { domainAllowed } = require('../utils/domain');
const { parseDate } = require('../utils/date');
const { buildYandexText, textMatches } = require('../utils/query');

class SearchProvider { async search() { throw new Error('SearchProvider.search должен быть реализован'); } }
class YandexAPIProvider extends SearchProvider { async search() { throw new Error('Yandex Search API пока не настроен'); } }

function inRange(date, query) { return !date || ((!query.from || date >= query.from) && (!query.to || date <= query.to)); }

class YandexHTMLProvider extends SearchProvider {
  constructor(browser, logger) { super(); this.browser = browser; this.log = logger; }
  async search(query, settings, hooks = {}) {
    query.yandexText = buildYandexText(query);
    const raw = await this.browser.collect(query, settings, hooks.onCaptcha);
    const candidates = [], seen = new Set(), candidateUrls = new Set(); let withinDuplicates = 0;
    for (const item of raw) {
      const normalized = normalizeUrl(item.url);
      if (!normalized || /(^|\.)yandex\.(ru|com)$/i.test(new URL(normalized).hostname)) continue;
      if (seen.has(normalized)) { withinDuplicates += 1; continue; }
      seen.add(normalized);
      const snippetMatch = textMatches(`${item.title} ${item.snippet}`, query);
      try {
        const page = await this.browser.inspect(item.url, query, settings);
        if (!textMatches(`${page.title} ${page.text}`, query)) continue;
        const date = parseDate(page.dateText) || parseDate(item.dateText);
        if (!inRange(date, query)) continue;
        const aggregator = /(^|\.)dzen\.ru$/i.test(new URL(item.url).hostname);
        const sources = page.sources?.length ? page.sources : aggregator ? [] : [{ url: item.url }];
        for (const source of sources) {
          const sourceUrl = normalizeUrl(source.url);
          if (!sourceUrl || !domainAllowed(sourceUrl, query.whitelist, query.blacklist)) continue;
          if (candidateUrls.has(sourceUrl)) { withinDuplicates += 1; continue; }
          candidateUrls.add(sourceUrl);
          candidates.push({ ...item, ...page, url: source.url, date, normalized: sourceUrl, snippetMatch });
        }
      } catch (error) {
        this.log.warn({ url: item.url, error: error.message }, 'Не удалось загрузить найденную страницу');
        if (!snippetMatch) continue;
        if (/(^|\.)dzen\.ru$/i.test(new URL(item.url).hostname)) continue;
        const date = parseDate(item.dateText);
        if (!inRange(date, query)) continue;
        if (!domainAllowed(normalized, query.whitelist, query.blacklist) || candidateUrls.has(normalized)) continue;
        candidateUrls.add(normalized);
        candidates.push({ ...item, date, normalized, description: String(item.snippet || '').slice(0, 300), snippetMatch: true });
      }
    }
    return { candidates, withinDuplicates };
  }
}
module.exports = { SearchProvider, YandexHTMLProvider, YandexAPIProvider, inRange };
