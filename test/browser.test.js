const test = require('node:test');
const assert = require('node:assert/strict');
const { applySearchParams, parseDuckDuckGoResults } = require('../src/browser');

test('переносит запрос и ограничения в общую веб-выдачу', () => {
  const url = applySearchParams('https://yandex.ru/search/?type=news', {
    yandexText: 'Ромашка новый завод', within: '7', from: '2024-03-01', to: '2024-03-08',
  }, 2);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/search/');
  assert.equal(parsed.searchParams.get('type'), null);
  assert.equal(parsed.searchParams.get('text'), 'Ромашка новый завод');
  assert.equal(parsed.searchParams.get('p'), '2');
  assert.equal(parsed.searchParams.get('within'), '7');
  assert.equal(parsed.searchParams.get('date'), '20240301-20240308');
});

test('создаёт отдельные URL страниц общего поиска', () => {
  const url = new URL(applySearchParams('https://yandex.ru/search/', { yandexText: 'тест' }, 3));
  assert.equal(url.searchParams.get('p'), '3');
  assert.equal(url.searchParams.get('text'), 'тест');
});

test('не принимает новостную вкладку и посторонние сайты', () => {
  assert.throws(() => applySearchParams('https://example.com/news', { yandexText: 'тест' }, 0), /общего поиска Яндекса/);
  assert.throws(() => applySearchParams('https://yandex.ru/news/search', { yandexText: 'тест' }, 0), /общего поиска Яндекса/);
});

test('разбирает резервную веб-выдачу без домена DuckDuckGo', () => {
  const rows = parseDuckDuckGoResults('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fnews&amp;rut=x">Заголовок</a><div class="result__snippet">Описание совпадения</div>');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://example.org/news');
  assert.equal(rows[0].title, 'Заголовок');
  assert.equal(rows[0].searchType, 'fallback');
});
