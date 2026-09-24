const test = require('node:test');
const assert = require('node:assert/strict');
const { applySearchParams } = require('../src/browser');

test('переносит запрос и ограничения в фактическую ссылку вкладки Новости', () => {
  const url = applySearchParams('https://yandex.ru/news/search?source=tab', {
    yandexText: 'Ромашка новый завод', within: '7', from: '2024-03-01', to: '2024-03-08',
  }, 2);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/news/search');
  assert.equal(parsed.searchParams.get('source'), 'tab');
  assert.equal(parsed.searchParams.get('text'), 'Ромашка новый завод');
  assert.equal(parsed.searchParams.get('p'), '2');
  assert.equal(parsed.searchParams.get('within'), '7');
  assert.equal(parsed.searchParams.get('date'), '20240301-20240308');
});

test('поддерживает актуальное перенаправление новостей на Дзен', () => {
  const url = new URL(applySearchParams('https://dzen.ru/news/search?issue_tld=ru', { yandexText: 'тест' }, 0));
  assert.equal(url.searchParams.get('type_filter'), 'news');
  assert.equal(url.searchParams.get('query'), 'тест');
});

test('не принимает ссылку Новости с постороннего сайта', () => {
  assert.throws(() => applySearchParams('https://example.com/news', { yandexText: 'тест' }, 0), /за пределы Яндекса и Дзена/);
});
