const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server');
const { openDatabase } = require('../src/db');

test('доля упоминаний сравнивает запросы за один период без дублей повторного поиска', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-voice-'));
  let service;
  try {
    service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0, token: 'voice-token' });
    const db = openDatabase(service.config.dbPath);
    const insert = db.prepare('INSERT INTO results (job_id,query,url,url_normalized,domain,date) VALUES (?,?,?,?,?,?)');
    insert.run('first', 'Минздрав ЛНР', 'https://news.test/one', 'https://news.test/one', 'news.test', '2026-10-01');
    insert.run('repeat', 'Минздрав ЛНР', 'https://news.test/one?ref=1', 'https://news.test/one', 'news.test', '2026-10-01');
    insert.run('first', 'Минздрав ЛНР', 'https://other.test/two', null, 'other.test', '2026-10-02');
    insert.run('second', 'Минобр ЛНР', 'https://news.test/one', 'https://news.test/one', 'news.test', '2026-10-01');
    insert.run('second', 'Минобр ЛНР', 'https://news.test/undated', null, 'news.test', null);
    db.close();
    const headers = { 'X-App-Token': 'voice-token' };
    const response = await fetch(`${service.url}/api/analytics/voice?from=2026-10-01&to=2026-10-02`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).groups, [
      { query: 'Минздрав ЛНР', mentions: 2, sources: 2 },
      { query: 'Минобр ЛНР', mentions: 1, sources: 1 },
    ]);
    const all = await fetch(`${service.url}/api/analytics/voice`, { headers });
    assert.equal((await all.json()).groups.find(row => row.query === 'Минобр ЛНР').mentions, 2);
    const invalid = await fetch(`${service.url}/api/analytics/voice?from=2026-10-03&to=2026-10-01`, { headers });
    assert.equal(invalid.status, 400);
    const unauthorized = await fetch(`${service.url}/api/analytics/voice`);
    assert.equal(unauthorized.status, 401);
  } finally {
    if (service) await service.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
