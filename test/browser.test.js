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

test('поздний редирект на CAPTCHA распознаётся до разбора пустой выдачи', async () => {
  const browser = new YandexBrowser({}, {}, 'data');
  browser.captchaDetectionWindow = 2000;
  let checks = 0;
  browser.isCaptcha = async () => { checks += 1; return checks >= 3; };
  browser.hasSearchCards = async () => false;
  let notified = false;
  await assert.rejects(browser.waitForResults({}, { captchaStrategy: 'skip' }, () => { notified = true; }), CaptchaError);
  assert.equal(notified, true);
  assert.equal(checks, 3);
});

test('адрес showcaptcha Яндекса считается блокировкой, обычная выдача — нет', async () => {
  const browser = new YandexBrowser({}, {}, 'data');
  browser.evaluate = async () => ({
    url: 'https://yandex.ru/showcaptcha?form-fb-hint=2.1&retpath=aHR0cHM6Ly95YW5kZXgucnUvc2VhcmNo',
    path: '/showcaptcha', title: 'Are you not a robot?', captcha: false,
  });
  assert.equal(await browser.isCaptcha({}), true);
  browser.evaluate = async () => ({ url: 'https://yandex.ru/search/?text=%D0%BA%D0%B0%D0%BF%D1%87%D0%B0', path: '/search/', title: ' капча — Яндекс', captcha: false });
  assert.equal(await browser.isCaptcha({}), false);
});

test('пустая выдача после редиректа на CAPTCHA повторяет страницу вместо ошибки', async () => {
  const browser = new YandexBrowser({}, { warn() {} }, 'data');
  const page = {
    closed: false, isClosed() { return this.closed; }, close: async () => { page.closed = true; },
    waitForSelector: async () => {}, setViewport: async () => {},
  };
  browser.open = async () => ({ once() {}, newPage: async () => page });
  browser.navigate = async () => ({ status: () => 200 });
  browser.waitForResults = async () => true;
  browser.waitForSearchCards = async () => true;
  let captchaChecks = 0;
  browser.isCaptcha = async () => { captchaChecks += 1; return captchaChecks === 1; };
  let reads = 0;
  const row = { title: 'Новость', url: 'https://example.com/a', snippet: 'текст', dateText: '' };
  browser.evaluate = async (target, fn) => {
    if (String(fn).includes('serp-item')) { reads += 1; return reads === 1 ? [] : [row]; }
    return { title: 'Are you not a robot?', body: '', url: 'https://yandex.ru/showcaptcha?x=1' };
  };
  let notified = 0, solved = 0;
  const collected = await browser.collect(
    { yandexText: 'тест' },
    { maxPages: 1, maxResults: 10, maxDurationMinutes: 5, captchaStrategy: 'manual', pageDelay: 0, pageJitter: 0 },
    { onCaptcha: () => { notified += 1; }, onCaptchaSolved: () => { solved += 1; } },
  );
  assert.equal(collected.length, 1);
  assert.equal(notified, 1);
  assert.equal(solved, 1);
  assert.equal(browser.captchaPage, null);
});

test('HTTP 429 показывает блокировку и открывает страницу после паузы', async () => {
  const browser = new YandexBrowser({}, { warn() {} }, 'data');
  browser.rateLimitDelays = [5, 5, 5];
  const page = {
    closed: false, isClosed() { return this.closed; }, close: async () => { page.closed = true; },
    waitForSelector: async () => {}, setViewport: async () => {},
  };
  browser.open = async () => ({ once() {}, newPage: async () => page });
  const statuses = [429, 200, 200];
  browser.navigate = async () => ({ status: () => statuses.shift() ?? 200 });
  browser.waitForResults = async () => true;
  browser.waitForSearchCards = async () => true;
  browser.isCaptcha = async () => false;
  const row = { title: 'Новость', url: 'https://example.com/a', snippet: 'текст', dateText: '' };
  browser.evaluate = async (target, fn) => (String(fn).includes('serp-item') ? [row] : []);
  let notified = 0, solved = 0;
  const collected = await browser.collect(
    { yandexText: 'тест' },
    { maxPages: 1, maxResults: 10, maxDurationMinutes: 5, captchaStrategy: 'manual', pageDelay: 0, pageJitter: 0 },
    { onCaptcha: () => { notified += 1; }, onCaptchaSolved: () => { solved += 1; } },
  );
  assert.equal(collected.length, 1);
  assert.equal(notified, 1);
  assert.equal(solved, 1);
  assert.equal(browser.captchaPage, null);
});

test('HTTP 429 при стратегии skip сразу завершает поиск', async () => {
  const browser = new YandexBrowser({}, {}, 'data');
  let notified = 0;
  await assert.rejects(
    browser.waitForRateLimit({ isClosed: () => false }, 'https://yandex.ru/search/', { captchaStrategy: 'skip' }, { onCaptcha: () => { notified += 1; } }),
    CaptchaError,
  );
  assert.equal(notified, 1);
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

test('страница Яндекса «400 Bad Request» не считается CAPTCHA', async () => {
  const browser = new YandexBrowser({}, {}, 'data');
  browser.evaluate = async () => ({
    url: 'https://yandex.ru/showcaptcha?retpath=aHR0cHM6Ly95YW5kZXgucnUvc2VhcmNo', path: '/showcaptcha',
    title: '400', captcha: false, blocked: true,
  });
  assert.equal(await browser.isCaptcha({}), false);
});

test('HTTP 400 от Яндекса повторяет страницу после паузы вместо ожидания CAPTCHA', async () => {
  const browser = new YandexBrowser({}, { warn() {} }, 'data');
  browser.rateLimitDelays = [5, 5, 5];
  const page = {
    closed: false, isClosed() { return this.closed; }, close: async () => { page.closed = true; },
    waitForSelector: async () => {}, setViewport: async () => {},
  };
  browser.open = async () => ({ once() {}, newPage: async () => page });
  const statuses = [400, 200];
  browser.navigate = async () => ({ status: () => statuses.shift() ?? 200 });
  browser.waitForResults = async () => true;
  browser.waitForSearchCards = async () => true;
  browser.isCaptcha = async () => false;
  const row = { title: 'Новость', url: 'https://example.com/a', snippet: 'текст', dateText: '' };
  browser.evaluate = async (target, fn) => (String(fn).includes('serp-item') ? [row] : { blocked: false });
  let notified = 0;
  const collected = await browser.collect(
    { yandexText: 'тест' },
    { maxPages: 1, maxResults: 10, maxDurationMinutes: 5, captchaStrategy: 'manual', pageDelay: 0, pageJitter: 0 },
    { onCaptcha: () => { notified += 1; } },
  );
  assert.equal(collected.length, 1);
  assert.equal(notified, 1);
  assert.equal(browser.captchaPage, null);
});

test('зависший снимок CAPTCHA завершается понятной ошибкой вместо вечного ожидания', async () => {
  const browser = new YandexBrowser({}, {}, 'data');
  browser.captchaScreenshotTimeout = 20;
  browser.cookieConsentTimeout = 20;
  browser.captchaPage = {
    isClosed: () => false, viewport: () => ({ width: 1000, height: 720 }),
    screenshot: () => new Promise(() => {}), frames: () => [],
  };
  await assert.rejects(browser.captchaScreenshot(), /не отдал изображение/);
  browser.captchaPage = null;
});

test('окно cookie Яндекса показывается над CAPTCHA и принимает согласие только по действию пользователя', async () => {
  const browser = new YandexBrowser({}, {}, 'data');
  const originalDocument = global.document;
  let clicked = 0;
  const button = {
    textContent: 'Принять все',
    closest: () => ({ innerText: 'Мы используем cookie для работы сервиса.' }),
    getClientRects: () => [{}],
    click: () => { clicked += 1; },
  };
  global.document = { querySelectorAll: () => [button] };
  browser.captchaPage = { isClosed: () => false, viewport: () => ({ width: 1000, height: 720 }),
    screenshot: async () => Buffer.from('image'), frames: () => [{ evaluate: async (fn, accept) => fn(accept) }] };
  try {
    const shot = await browser.captchaScreenshot();
    assert.deepEqual(shot.cookieConsent, { label: 'Принять все' });
    assert.equal(clicked, 0);
    await browser.captchaAction({ type: 'accept_cookies' });
    assert.equal(clicked, 1);
    button.closest = () => ({ innerText: 'Обычная проверка CAPTCHA' });
    assert.equal((await browser.captchaScreenshot()).cookieConsent, null);
    await assert.rejects(browser.captchaAction({ type: 'accept_cookies' }), /больше не найдено/);
  } finally {
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
    browser.captchaPage = null;
  }
});
