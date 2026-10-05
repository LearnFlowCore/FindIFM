const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { startServer, highlightedHtml } = require('../src/server');
const { openDatabase } = require('../src/db');
const { summarize } = require('../public/dynamics');

test('подсветка целой фразы экранирует спецсимволы и не портит HTML', () => {
  const html = highlightedHtml('<html><body><p>C++ example</p></body></html>', 'https://example.org/', 'C++ example');
  assert.equal((html.match(/<\/body>/g) || []).length, 1);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const document = { body: {}, createTreeWalker: () => ({ nextNode: () => false }) };
  assert.equal(vm.runInNewContext(script.replace(/\}\)\(\)$/, "return pattern.test('C++ example')})()"), { document, NodeFilter: { SHOW_TEXT: 4 } }), true);
});

test('сохранённые ссылки группируются по дате публикации и выбранному периоду', () => {
  assert.deepEqual(summarize([
    { date: '2026-09-30' }, { date: '2026-09-30' }, { date: '2026-10-01' }, { date: '' },
  ], '2026-09-30', '2026-09-30'), { points: [{ day: '2026-09-30', count: 2 }], total: 2 });
});

test('отчёт и динамика учитывают поисковый запуск и период; файл скачивается с токеном', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-report-'));
  let service;
  try {
    service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0, token: 'test-token' });
    const db = openDatabase(service.config.dbPath);
    db.prepare("INSERT INTO search_history (job_id,query,status) VALUES ('one','ключ','completed'),('two','другой','completed')").run();
    const insert = db.prepare('INSERT INTO results (job_id,url,domain,title,date,description,query) VALUES (?,?,?,?,?,?,?)');
    insert.run('one', 'https://example.org/a', 'example.org', '=1+1', '2026-09-30', 'Описание', 'ключ');
    insert.run('one', 'https://example.org/b', 'example.org', 'Вторая', '2026-10-01', 'Описание', 'ключ');
    insert.run('one', 'https://example.org/c', 'example.org', 'Без даты', null, 'Описание', 'ключ');
    insert.run('two', 'https://other.org/d', 'other.org', 'Чужая', '2026-09-30', 'Описание', 'другой');
    db.prepare("UPDATE search_history SET extracted_date='2026-09-30', date_from='2026-09-30', date_to='2026-09-30' WHERE job_id='one'").run();
    db.close();
    const headers = { 'X-App-Token': 'test-token', 'Content-Type': 'application/json' };
    const dynamics = await fetch(`${service.url}/api/results/dynamics?jobId=one&from=2026-09-30&to=2026-09-30`, { headers });
    assert.equal(dynamics.status, 200);
    assert.deepEqual(await dynamics.json(), { points: [{ day: '2026-09-30', count: 1 }], total: 1 });
    const report = await fetch(`${service.url}/api/export/report`, { method: 'POST', headers,
      body: JSON.stringify({ scope: 'current', jobId: 'one', from: '2026-09-30', to: '2026-09-30', format: 'csv' }) });
    assert.equal(report.status, 200);
    const result = await report.json();
    assert.equal(result.count, 1);
    const file = await fetch(`${service.url}${result.url}`);
    assert.equal(file.status, 200);
    const content = await file.text();
    assert.match(content, /Домен.*Статус.*Запрос/);
    assert.match(content, /example\.org.*ключ/);
    assert.match(content, /'=?1\+1/);
    assert.match(content, /https:\/\/example.org\/a/);
    assert.doesNotMatch(content, /https:\/\/example.org\/b|https:\/\/other.org\/d/);
    const byDate = await fetch(`${service.url}/api/export/by-query-date`, { method: 'POST', headers, body: JSON.stringify({ jobId: 'one' }) });
    assert.equal(byDate.status, 200);
    const dated = await byDate.json();
    assert.equal(dated.count, 1);
    const datedFile = await fetch(`${service.url}${dated.csv.url}`);
    assert.equal(datedFile.status, 200);
    assert.match(await datedFile.text(), /Домен.*Статус.*Запрос[\s\S]*example\.org.*ключ/);
    const invalid = await fetch(`${service.url}/api/export/report`, { method: 'POST', headers,
      body: JSON.stringify({ scope: 'all', from: '2026-02-30', format: 'txt' }) });
    assert.equal(invalid.status, 400);
    await invalid.json();
    const missing = await fetch(`${service.url}/api/export/report`, { method: 'POST', headers,
      body: JSON.stringify({ scope: 'current', format: 'txt' }) });
    assert.equal(missing.status, 400);
    await missing.json();
  } finally {
    if (service) await service.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
