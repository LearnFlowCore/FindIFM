const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer } = require('../src/server');
const { parseQuery } = require('../src/utils/query');

test('desktop API слушает случайный локальный порт и требует токен', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-monitor-server-'));
  const service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0, token: 'test-token' });
  try {
    assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const unauthorized = await fetch(`${service.url}/api/history`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${service.url}/api/history`, { headers: { 'X-App-Token': 'test-token' } });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), []);
  } finally {
    await service.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('API возвращает JSON при некорректном теле запроса', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-monitor-json-'));
  const service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0, token: 'test-token' });
  try {
    const response = await fetch(`${service.url}/api/search`, {
      method: 'POST', headers: { 'X-App-Token': 'test-token', 'Content-Type': 'application/json' }, body: '{broken',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'API получил некорректный JSON.' });
  } finally {
    await service.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('API формирует FindIFM.txt с одной ссылкой на строке', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-monitor-txt-'));
  const service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0, token: 'test-token' });
  try {
    const response = await fetch(`${service.url}/api/export/txt`, {
      method: 'POST', headers: { 'X-App-Token': 'test-token', 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.file, 'FindIFM.txt');
    assert.equal(result.count, 0);
    const download = await fetch(`${service.url}${result.url}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), '');
  } finally {
    await service.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('CAPTCHA access возвращает токен только для живой ожидающей задачи с доступом к приложению', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-monitor-captcha-access-'));
  const service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0, token: 'test-token' });
  try {
    const id = crypto.randomUUID();
    const query = parseQuery({ query: 'пример' });
    const job = { id, query, status: 'waiting_captcha', progress: 5, results: [], liveResults: [] };
    service.jobs.repo.addHistory(id, query);
    service.jobs.repo.updateTask(id, 'waiting_captcha', 5, 'Ожидание CAPTCHA');
    service.jobs.jobs.set(id, job);
    service.jobs.captchaTokens.set(id, 'secret-captcha-token');
    const headers = { 'X-App-Token': 'test-token' };
    const jobsResponse = await fetch(`${service.url}/api/jobs`, { headers });
    const jobs = await jobsResponse.json();
    assert.equal(jobsResponse.status, 200);
    assert.equal(jobs.find(item => item.job_id === id).live.status, 'waiting_captcha');
    assert.equal(JSON.stringify(jobs).includes('secret-captcha-token'), false);
    const jobResponse = await fetch(`${service.url}/api/jobs/${id}`, { headers });
    assert.equal(jobResponse.status, 200);
    assert.equal((await jobResponse.json()).captchaToken, undefined);
    const url = `${service.url}/api/jobs/${id}/captcha/access`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'X-App-Token': 'wrong' } })).status, 401);
    const access = await fetch(url, { headers });
    assert.equal(access.status, 200);
    assert.equal(access.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await access.json(), { captchaToken: 'secret-captcha-token' });
    job.status = 'running';
    assert.equal((await fetch(url, { headers })).status, 409);
    job.status = 'completed';
    assert.equal((await fetch(url, { headers })).status, 409);
    assert.equal((await fetch(`${service.url}/api/jobs/${crypto.randomUUID()}/captcha/access`, { headers })).status, 404);
  } finally {
    await service.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
