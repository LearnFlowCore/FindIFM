const test = require('node:test');
const assert = require('node:assert/strict');
const { YandexBrowser } = require('../src/browser');

test('navigate использует DOM-загрузку с ограниченным тайм-аутом', async () => {
  const browser = new YandexBrowser({}, { warn() {} }, '');
  let options;
  const page = {
    isClosed: () => false,
    goto: async (_url, value) => { options = value; return { status: () => 200 }; },
  };
  const response = await browser.navigate(page, 'https://example.com');
  assert.equal(response.status(), 200);
  assert.equal(options.waitUntil, 'domcontentloaded');
  assert.equal(options.timeout, 20000);
});

test('evaluate повторяется после замены контекста при навигации', async () => {
  const browser = new YandexBrowser({}, {}, '');
  let attempts = 0;
  const page = {
    isClosed: () => false,
    evaluate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Execution context was destroyed, most likely because of a navigation.');
      return 'ready';
    },
  };
  assert.equal(await browser.evaluate(page, () => document.title), 'ready');
  assert.equal(attempts, 2);
});

test('ожидает появления карточек новостной выдачи', async () => {
  const browser = new YandexBrowser({}, {}, '');
  let selector;
  const page = {
    isClosed: () => false,
    waitForSelector: async value => { selector = value; },
  };
  await browser.waitForNewsCards(page);
  assert.match(selector, /news-link-new_primary/);
});
