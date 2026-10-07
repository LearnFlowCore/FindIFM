const test = require('node:test');
const assert = require('node:assert/strict');
const { YandexHTMLProvider, inRange } = require('../src/search/provider');
const { parseQuery } = require('../src/utils/query');

test('дата неизвестной публикации не отбрасывается преждевременно', () => {
  const query = parseQuery({ query: 'Министерство', from: '2026-10-07', to: '2026-10-07' });
  assert.equal(inRange(null, query), true);
  assert.equal(inRange('2026-10-06', query), false);
  assert.equal(inRange('2026-10-07', query), true);
});

test('короткий сниппет лишь задаёт приоритет: текст статьи всё равно проверяется', async () => {
  const inspected = [];
  const stats = [];
  const browser = {
    collect: async () => [
      { url: 'https://example.org/hidden', title: 'Заголовок', snippet: 'Краткое описание' },
      { url: 'https://example.org/visible', title: 'Ромашка', snippet: 'Ромашка' },
      { url: 'https://example.org/visible#section', title: 'Ромашка', snippet: 'Повтор' },
    ],
    inspect: async url => { inspected.push(url); return { title: 'Публикация', text: 'Ромашка упомянута в статье', links: [] }; },
  };
  const provider = new YandexHTMLProvider(browser, { warn() {} });
  const result = await provider.search(parseQuery({ query: 'Ромашка', deepPages: 0 }), { maxResults: 5, maxDurationMinutes: 1 }, { onSearchStats: data => stats.push(data) });
  assert.deepEqual(inspected, ['https://example.org/hidden', 'https://example.org/visible']);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(stats, [{ found: 3, duplicates: 1, inspected: 2, skipped: 1, accepted: 2,
    rootInspected: 2, deepLinksFound: 0, deepLinksSelected: 0, deepPagesInspected: 0, deepAccepted: 0 }]);
});

test('ранжирует URL внутренних страниц и соблюдает конфигурируемый предел 4/8/12', async () => {
  const links = Array.from({ length: 15 }, (_, i) => `https://example.org/section-${i}`);
  links[14] = 'https://example.org/romashka-story';
  const visited = [];
  const browser = {
    collect: async () => [{ url: 'https://example.org/', title: 'Главная', snippet: 'Каталог' }],
    inspect: async url => { visited.push(url); return { title: 'Страница', text: 'Нет совпадения', links: url === 'https://example.org' ? links : [] }; },
  };
  const provider = new YandexHTMLProvider(browser, { warn() {} });
  for (const [setting, expected] of [[4, 4], [8, 8], [20, 12]]) {
    visited.length = 0;
    let stats;
    const result = await provider.search(parseQuery({ query: 'romashka', deepPages: 12 }),
      { maxResults: 20, maxDurationMinutes: 1, ...(setting === undefined ? {} : { maxDeepPages: setting }) },
      { onSearchStats: value => { stats = value; } });
    assert.equal(visited.length, expected + 1);
    assert.equal(visited[1], 'https://example.org/romashka-story');
    assert.equal(result.candidates.length, 0);
    assert.equal(stats.deepLinksFound, 15);
    assert.equal(stats.deepLinksSelected, expected);
    assert.equal(stats.deepPagesInspected, expected);
    assert.equal(stats.deepAccepted, 0);
    assert.equal(stats.rootInspected, 1);
  }
});

test('адаптивный обход останавливается после успешной первой партии из четырёх ссылок', async () => {
  const links = Array.from({ length: 12 }, (_, i) => `https://example.org/section-${i + 1}`);
  const visited = [];
  let stats;
  const browser = {
    collect: async () => [{ url: 'https://example.org/', title: 'Каталог', snippet: '' }],
    inspect: async url => {
      visited.push(url);
      return { title: 'Страница', text: url.endsWith('/section-3') ? 'Ромашка' : 'Нет совпадения', links: url === 'https://example.org' ? links : [] };
    },
  };
  const result = await new YandexHTMLProvider(browser, { warn() {} }).search(
    parseQuery({ query: 'Ромашка', deepPages: 12 }), { maxDeepPages: 12, maxResults: 20, maxDurationMinutes: 1 },
    { onSearchStats: value => { stats = value; } });
  assert.deepEqual(visited, ['https://example.org', ...links.slice(0, 4)]);
  assert.deepEqual(result.candidates.map(row => row.url), [links[2]]);
  assert.equal(stats.deepLinksFound, 12);
  assert.equal(stats.deepLinksSelected, 4);
  assert.equal(stats.deepPagesInspected, 4);
  assert.equal(stats.deepAccepted, 1);
});

test('без совпадений в первых двух партиях доходит до девятой ссылки', async () => {
  const links = Array.from({ length: 12 }, (_, i) => `https://example.org/section-${i + 1}`);
  const visited = [];
  const browser = {
    collect: async () => [{ url: 'https://example.org/', title: 'Каталог', snippet: '' }],
    inspect: async url => {
      visited.push(url);
      return { title: 'Страница', text: url.endsWith('/section-9') ? 'Ромашка' : 'Нет совпадения', links: url === 'https://example.org' ? links : [] };
    },
  };
  const result = await new YandexHTMLProvider(browser, { warn() {} }).search(
    parseQuery({ query: 'Ромашка', deepPages: 12 }), { maxDeepPages: 12, maxResults: 20, maxDurationMinutes: 1 });
  assert.equal(visited.length, 13);
  assert(visited.includes(links[8]));
  assert.deepEqual(result.candidates.map(row => row.url), [links[8]]);
});

test('три ссылки, дубликаты, другой хост и файлы не увеличивают число inspect', async () => {
  const links = ['https://example.org/one', 'https://example.org/two', 'https://example.org/three'];
  const visited = [];
  let stats;
  const browser = {
    collect: async () => [{ url: 'https://example.org/', title: 'Каталог', snippet: '' }],
    inspect: async url => {
      visited.push(url);
      return { title: 'Страница', text: 'Нет совпадения', links: url === 'https://example.org'
        ? [...links, links[0], `${links[0]}#chapter`, 'https://elsewhere.org/four', 'https://example.org/file.pdf', 'https://example.org/image.png', 'https://example.org/archive.zip'] : [] };
    },
  };
  await new YandexHTMLProvider(browser, { warn() {} }).search(
    parseQuery({ query: 'Ромашка', deepPages: 12 }), { maxDeepPages: 12, maxResults: 20, maxDurationMinutes: 1 },
    { onSearchStats: value => { stats = value; } });
  assert.deepEqual(visited, ['https://example.org', ...links]);
  assert.equal(stats.deepPagesInspected, 3);
  assert.equal(stats.deepLinksSelected, 3);
});

test('находит упоминание на внутренней странице, когда главная страница не совпадает', async () => {
  const visited = [];
  const browser = {
    collect: async () => [{ url: 'https://example.org/', title: 'Главная', snippet: 'Каталог' }],
    inspect: async url => {
      visited.push(url);
      if (url === 'https://example.org') return {
        title: 'Каталог', text: 'О компании', links: [
          'https://example.org/about', 'https://example.org/news',
          'https://external.org/private', 'javascript:alert(1)',
        ],
      };
      return { title: 'Пресс-релиз', text: url.endsWith('news') ? 'Ромашка открыла завод' : 'Контакты', links: [] };
    },
  };
  const provider = new YandexHTMLProvider(browser, { warn() {} });
  const result = await provider.search(parseQuery({ query: 'Ромашка завод', deepPages: 5 }), { maxResults: 20, maxDurationMinutes: 1 });
  assert.deepEqual(result.candidates.map(row => row.url), ['https://example.org/news']);
  assert.deepEqual(visited, ['https://example.org', 'https://example.org/about', 'https://example.org/news']);
});

test('ограничивает число внутренних страниц, позволяет отключить обход', async () => {
  const visited = [];
  const browser = {
    collect: async () => [{ url: 'https://example.org/', title: 'Главная', snippet: '' }],
    inspect: async url => {
      visited.push(url);
      return { title: 'Главная', text: '', links: ['/ignored', 'https://example.org/one', 'https://example.org/two'] };
    },
  };
  const provider = new YandexHTMLProvider(browser, { warn() {} });
  await provider.search(parseQuery({ query: 'упоминание', deepPages: 1 }), { maxResults: 20, maxDurationMinutes: 1 });
  assert.deepEqual(visited, ['https://example.org', 'https://example.org/one']);
  visited.length = 0;
  await provider.search(parseQuery({ query: 'упоминание', deepPages: 0 }), { maxResults: 20, maxDurationMinutes: 1 });
  assert.deepEqual(visited, ['https://example.org']);
});

test('обходит два перехода и применяет фильтры к фактической странице', async () => {
  const browser = {
    collect: async () => [{ url: 'https://example.org/', title: 'Сайт', snippet: '' }],
    inspect: async url => ({
      title: url.endsWith('/story') ? 'Статья' : 'Раздел',
      text: url.endsWith('/story') ? 'Упоминание проекта Ромашка' : 'Новости компании',
      links: url === 'https://example.org' ? ['https://example.org/section']
        : url.endsWith('/section') ? ['https://example.org/story', 'https://outside.org/story'] : [],
    }),
  };
  const provider = new YandexHTMLProvider(browser, { warn() {} });
  const result = await provider.search(parseQuery({ query: 'Ромашка', deepPages: 2, whitelist: ['example.org'] }), { maxResults: 20, maxDurationMinutes: 1 });
  assert.deepEqual(result.candidates.map(row => row.url), ['https://example.org/story']);
  const disabled = await provider.search(parseQuery({ query: 'Ромашка', deepPages: 1 }), { maxResults: 20, maxDurationMinutes: 1 });
  assert.equal(disabled.candidates.length, 0);
});

test('передаёт публикации по мере проверки и соблюдает время окончания поиска', async () => {
  const found = [];
  let inspections = 0;
  const browser = {
    collect: async () => [{ url: 'https://example.org/story', title: 'Ромашка', snippet: 'Ромашка открыла завод' }],
    inspect: async () => { inspections += 1; return { title: 'Ромашка открыла завод', text: 'Ромашка открыла завод', links: [] }; },
  };
  const provider = new YandexHTMLProvider(browser, { warn() {} });
  const query = parseQuery({ query: 'Ромашка' });
  const result = await provider.search(query, { maxDurationMinutes: 1 }, { onCandidate: row => found.push(row.url) });
  assert.deepEqual(found, ['https://example.org/story']);
  assert.equal(result.candidates.length, 1);
  const expired = await provider.search(query, { deadlineAt: Date.now() - 1000 }, { onCandidate: row => found.push(row.url) });
  assert.equal(expired.candidates.length, 0);
  assert.equal(inspections, 1);
  assert.equal(found.length, 1);
});

test('при истечении CAPTCHA обрабатывает страницы до остановки и отмечает поиск приостановленным', async () => {
  const browser = {
    collect: async () => { const error = new Error('CAPTCHA'); error.code = 'CAPTCHA_TIMEOUT'; error.partialSearchRows = [{ url: 'https://example.org/one', title: 'Ромашка', snippet: 'Ромашка' }]; throw error; },
    inspect: async () => ({ title: 'Ромашка', text: 'Ромашка', links: [] }),
  };
  const result = await new YandexHTMLProvider(browser, { warn() {} }).search(parseQuery({ query: 'Ромашка' }), { deadlineAt: Date.now() - 1 });
  assert.equal(result.pausedCaptcha, true);
  assert.equal(result.candidates.length, 1);
});
