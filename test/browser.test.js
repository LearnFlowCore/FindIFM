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

test('ручная CAPTCHA предоставляет изображение и ограничивает действия текущей страницей', async () => {
  const browser = new YandexBrowser({}, {}, 'data');
  const events = [];
  browser.captchaPage = {
    isClosed: () => false, viewport: () => ({ width: 1000, height: 720 }),
    screenshot: async () => Buffer.from('image'),
    mouse: { move: async (x, y) => events.push(['move', x, y]), down: async () => events.push(['down']), up: async () => events.push(['up']) },
    keyboard: { type: async value => events.push(['text', value]), press: async value => events.push(['key', value]) },
  };
  const shot = await browser.captchaScreenshot();
  assert.equal(shot.image, 'data:image/jpeg;base64,aW1hZ2U=');
  assert.equal(shot.width, 1000);
  await browser.captchaAction({ type: 'down', x: 80, y: 100 });
  await browser.captchaAction({ type: 'up', x: 150, y: 100 });
  await browser.captchaAction({ type: 'text', value: 'пример' });
  await browser.captchaAction({ type: 'key', value: 'Enter' });
  assert.deepEqual(events, [['move', 80, 100], ['down'], ['move', 150, 100], ['up'], ['text', 'пример'], ['key', 'Enter']]);
  await assert.rejects(browser.captchaAction({ type: 'down', x: -1, y: 0 }), /координаты/);
  await assert.rejects(browser.captchaAction({ type: 'key', value: 'Control+L' }), /Недопустимое/);
  browser.captchaPage = null;
  await assert.rejects(browser.captchaScreenshot(), /недоступно/);
});
