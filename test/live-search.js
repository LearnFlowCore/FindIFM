// Ручная сквозная проверка поиска: node test/live-search.js [запрос]
const os = require('node:os');
const path = require('node:path');
const { YandexBrowser } = require('../src/browser');
const { YandexHTMLProvider } = require('../src/search/provider');
const { parseQuery } = require('../src/utils/query');
const { findYandexBrowser } = require('../src/config');

async function main() {
  const executable = findYandexBrowser();
  if (!executable) throw new Error('Яндекс Браузер не найден');
  const logger = { warn: console.warn, debug: () => {} };
  const browser = new YandexBrowser({ browserExecutable: executable }, logger, path.join(os.tmpdir(), 'mention-monitor-live-check'));
  const query = parseQuery({ query: process.argv.slice(2).join(' ') || 'Википедия', deepPages: 2 });
  try {
    const provider = new YandexHTMLProvider(browser, logger);
    const result = await provider.search(query, {
      maxPages: 1, maxResults: 5, maxDurationMinutes: 4,
      pageDelay: 0, pageJitter: 0, resultDelay: 0, resultJitter: 0,
      captchaStrategy: 'skip',
    }, {
      onCaptcha: () => console.error('CAPTCHA: требуется ручное подтверждение в браузере'),
      onCheckpoint: (page, count) => console.log(`Выдача: страница ${page}, карточек ${count}`),
      onSitePage: (checked, url, found) => console.log(`Проверено ${checked}: ${url}; совпадений ${found}`),
    });
    console.log(JSON.stringify({ found: result.candidates.length, results: result.candidates.map(({ url, title }) => ({ url, title })) }, null, 2));
    if (!result.candidates.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
