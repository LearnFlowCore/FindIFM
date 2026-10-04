const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer } = require('../src/server');
const { openDatabase } = require('../src/db');
const { Repository } = require('../src/repository');
const { metrics } = require('../src/analytics');

test('существующая история поиска получает колонки аналитики без потери запусков', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-analytics-migration-'));
  const file = path.join(folder, 'history.db');
  let upgraded;
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE search_history (id INTEGER PRIMARY KEY, job_id TEXT); INSERT INTO search_history (job_id) VALUES ('old-job')");
    old.close();
    upgraded = openDatabase(file);
    const row = upgraded.prepare("SELECT job_id, spike_at, notified_at, response_at FROM search_history WHERE job_id='old-job'").get();
    assert.equal(row.job_id, 'old-job');
    assert.equal(row.spike_at, null);
    assert.equal(row.notified_at, null);
    assert.equal(row.response_at, null);
  } finally {
    upgraded?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('два интервала не зависят от фиксации другого события', () => {
  const times = { spikeAt: '2026-10-04T09:00:00.000Z', notifiedAt: '2026-10-04T09:11:00.000Z', responseAt: null };
  assert.deepEqual(metrics(times), { spikeToNotificationSeconds: 660, notificationToResponseSeconds: null });
  times.responseAt = '2026-10-04T13:02:00.000Z';
  assert.deepEqual(metrics(times), { spikeToNotificationSeconds: 660, notificationToResponseSeconds: 13860 });
  times.spikeAt = null;
  assert.deepEqual(metrics(times), { spikeToNotificationSeconds: null, notificationToResponseSeconds: 13860 });
});

test('аналитика запуска переживает рестарт и отклоняет обратный порядок дат', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-analytics-'));
  let service;
  try {
    service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0 });
    // Запись запуска без сетевого поиска: публичный API читает ту же историю SQLite.
    const db = openDatabase(service.config.dbPath);
    new Repository(db).addHistory('analytics-job', { original: 'тестовый запрос', extractedDate: null, period: null, from: null, to: null, whitelist: [], blacklist: [] });
    db.close();
    const url = `${service.url}/api/analytics/analytics-job`;
    const update = body => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let response = await update({ spikeAt: '2026-10-04T12:00:00+03:00', notifiedAt: '2026-10-04T12:10:00+03:00' });
    assert.equal(response.status, 200);
    assert.deepEqual((({ spikeToNotificationSeconds, notificationToResponseSeconds }) => ({ spikeToNotificationSeconds, notificationToResponseSeconds }))(await response.json()),
      { spikeToNotificationSeconds: 600, notificationToResponseSeconds: null });
    response = await update({ responseAt: '2026-10-04T09:40:00Z' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).notificationToResponseSeconds, 1800);
    response = await update({ responseAt: '2026-10-04T09:05:00Z' });
    assert.equal(response.status, 400);
    await response.json();
    response = await update({ spikeAt: 'not a date' });
    assert.equal(response.status, 400);
    await response.json();
    await new Promise(resolve => setTimeout(resolve, 200));
    await service.stop(); service = null;
    service = await startServer({ dataRoot: folder, host: '127.0.0.1', port: 0 });
    const saved = await fetch(`${service.url}/api/analytics/analytics-job`).then(r => r.json());
    assert.equal(saved.spikeToNotificationSeconds, 600);
    assert.equal(saved.notificationToResponseSeconds, 1800);
    response = await fetch(`${service.url}/api/analytics/missing-job`);
    assert.equal(response.status, 404);
    await response.json();
  } finally {
    if (service) await service.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
