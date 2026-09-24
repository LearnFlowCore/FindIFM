const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server');

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
