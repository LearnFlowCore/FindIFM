const test = require('node:test');
const assert = require('node:assert/strict');
const { YandexHTMLProvider } = require('../src/search/provider');
const { parseQuery } = require('../src/utils/query');

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
