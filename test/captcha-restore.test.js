const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');
const { startServer } = require('../src/server');
const { parseQuery } = require('../src/utils/query');

const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');

test('F5 восстанавливает CAPTCHA одной живой задачи и прячет панель после подтверждения',
  { skip: !fs.existsSync(chrome) }, async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-monitor-reload-'));
    const service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0, token: 'test-token' });
    let browser;
    try {
      const id = crypto.randomUUID();
      const query = parseQuery({ query: 'пример' });
      const job = { id, query, status: 'waiting_captcha', progress: 5, captcha: true,
        results: [], liveResults: [], recentChecks: [], startedAt: Date.now(), deadlineAt: Date.now() + 60000 };
      service.jobs.repo.addHistory(id, query);
      service.jobs.repo.updateTask(id, 'waiting_captcha', 5, 'Ожидание CAPTCHA');
      service.jobs.jobs.set(id, job);
      service.jobs.captchaTokens.set(id, 'secret-captcha-token');
      browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      const requests = [];
      page.on('request', request => { if (request.url().includes('/api/')) requests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`${service.url}/#token=test-token`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.querySelector('#captchaPanel').hidden, { timeout: 10000 });
      assert.deepEqual(pageErrors, []);
      assert.equal(await page.$eval('#captchaWarning', el => el.hidden), false);
      assert.equal(await page.$eval('#openCaptchaWindow', el => el.disabled), false);
      const initialHistory = (await (await fetch(`${service.url}/api/history`, { headers: { 'X-App-Token': 'test-token' } })).json()).length;
      requests.length = 0;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.querySelector('#captchaPanel').hidden, { timeout: 10000 });
      assert.equal(await page.$eval('#captchaWarning', el => el.hidden), false);
      assert.equal(await page.$eval('#openCaptchaWindow', el => el.disabled), false);
      assert.equal(requests.filter(request => request === 'GET /api/jobs').length, 1);
      assert.equal(requests.filter(request => request === `GET /api/jobs/${id}/captcha/access`).length, 1);
      assert.equal(requests.filter(request => request === `GET /api/search/${id}`).length, 1);
      assert.equal(requests.some(request => request === 'POST /api/search'), false);
      assert.equal((await (await fetch(`${service.url}/api/history`, { headers: { 'X-App-Token': 'test-token' } })).json()).length, initialHistory);
      const popupPromise = new Promise(resolve => page.once('popup', resolve));
      await page.click('#captchaWarningOpen');
      const popup = await popupPromise;
      await popup.waitForFunction(() => document.querySelector('#hint').textContent.includes('Не удалось обновить изображение'), { timeout: 10000 });
      // This fixture has no real Yandex page: a 500 from screenshot proves the recovered
      // token passed both access checks (without it the request would return 403).
      assert.match(await popup.$eval('#hint', el => el.textContent), /Окно CAPTCHA уже недоступно/);
      assert.equal(new URL(popup.url()).searchParams.get('job'), id);
      job.status = 'running';
      job.captcha = false;
      await page.waitForFunction(() => document.querySelector('#captchaPanel').hidden && document.querySelector('#captchaWarning').hidden, { timeout: 10000 });
      requests.length = 0;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#monitorState').textContent.includes('Поиск в реальном времени'), { timeout: 10000 });
      assert.equal(await page.$eval('#captchaPanel', el => el.hidden), true);
      assert.equal(requests.filter(request => request === `GET /api/jobs/${id}/captcha/access`).length, 0);
      job.status = 'waiting_captcha';
      job.captcha = true;
      await page.waitForFunction(() => !document.querySelector('#captchaPanel').hidden, { timeout: 10000 });
      assert.equal(requests.filter(request => request === `GET /api/jobs/${id}/captcha/access`).length, 1);
      job.status = 'queued';
      await page.waitForFunction(() => document.querySelector('#captchaPanel').hidden, { timeout: 10000 });
      requests.length = 0;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#monitorState').textContent.includes('Поиск в реальном времени'), { timeout: 10000 });
      assert.equal(requests.filter(request => request === `GET /api/search/${id}`).length, 1);
      assert.equal(await page.$eval('#captchaPanel', el => el.hidden), true);
      job.status = 'completed';
      await page.waitForFunction(() => document.querySelector('#captchaPanel').hidden, { timeout: 10000 });
      requests.length = 0;
      const jobsLoaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs', { timeout: 10000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await jobsLoaded;
      assert.equal(requests.filter(request => request === `GET /api/search/${id}`).length, 0);
      assert.equal(await page.$eval('#captchaPanel', el => el.hidden), true);
      assert.deepEqual(pageErrors, []);
    } finally {
      if (browser) await browser.close();
      await service.stop();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
