const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { startServer } = require('../src/server');

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('форма отправляет название и точную дату без изменения формата API', { skip: !fs.existsSync(chrome) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-search-form-'));
  let service, browser;
  try {
    service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0, token: 'test-token' });
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    let submitted;
    let capture;
    const captured = new Promise(resolve => { capture = resolve; });
    page.on('request', request => {
      if (request.url().endsWith('/api/search') && request.method() === 'POST') {
        submitted = JSON.parse(request.postData());
        capture();
        request.respond({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Тест формы' }) });
      } else if (request.url().endsWith('/api/status')) {
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ internet: true, semanticAvailable: false }) });
      } else request.continue();
    });
    await page.goto(`${service.url}/#token=test-token`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#quickTestButton');
    assert.equal(await page.$eval('.search-options', element => element.open), false);
    assert.equal(await page.$eval('#searchForm [name="deepPages"]', element => element.value), '12');
    await page.$eval('#searchForm [name="query"]', element => { element.value = 'Министерство'; });
    await page.$eval('#searchForm [name="date"]', element => {
      element.value = '2026-10-07';
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('#launchButton');
    await captured;
    assert.deepEqual([submitted.query, submitted.from, submitted.to], ['Министерство', '2026-10-07', '2026-10-07']);
    assert.equal(Object.hasOwn(submitted, 'date'), false);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (service) await service.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
