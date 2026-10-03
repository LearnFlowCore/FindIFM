const test = require('node:test');
const assert = require('node:assert/strict');
const { applySearchParams, YandexBrowser, CaptchaError } = require('../src/browser');

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

test('CAPTCHA при skip завершает поиск Яндекса ошибкой вместо пустого результата', async () => {
  const browser = new YandexBrowser({}, {}, 'data');
  browser.isCaptcha = async () => true;
  let notified = false;
  await assert.rejects(browser.waitForResults({}, { captchaStrategy: 'skip' }, () => { notified = true; }), CaptchaError);
  assert.equal(notified, true);
});
