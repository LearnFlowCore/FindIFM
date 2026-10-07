const test = require('node:test');
const assert = require('node:assert/strict');
const { JobManager } = require('../src/jobs');
const { openDatabase } = require('../src/db');
const { Repository } = require('../src/repository');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function repository() {
  const entries = [];
  return {
    entries, addHistory() {}, addTaskLog() {}, updateTask() {}, updateQuery() {},
    settings: () => ({ maxPages: 5, maxResults: 500, maxDurationMinutes: 30 }),
    addResults: (_id, rows) => entries.push(...rows), hasUrl: () => false,
    finishHistory() {},
  };
}

test('быстрый тест ограничивает выдачу одной страницей и сохраняет TXT', async () => {
  const repo = repository();
  let settings;
  const provider = {
    browser: { close: async () => {} },
    search: async (_query, options) => { settings = options; return { candidates: [], withinDuplicates: 0 }; },
  };
  const jobs = new JobManager(repo, provider, { error() {} }, () => {}, async () => ({ ok: true }));
  const id = jobs.start({ query: 'пример', quickTest: true });
  await jobs.waitForIdle();
  assert.equal(settings.maxPages, 1);
  assert.equal(settings.maxResults, 5);
  assert.equal(jobs.get(id).status, 'completed');
  assert.match(jobs.get(id).textFile, /FindIFM_/);
});

test('остановка отменяет сохранение результатов и завершает задачу', async () => {
  const repo = repository();
  let resolveSearch;
  const provider = {
    browser: { close: async () => resolveSearch({ candidates: [], withinDuplicates: 0 }) },
    search: () => new Promise(resolve => { resolveSearch = resolve; }),
  };
  const jobs = new JobManager(repo, provider, { error() {} }, () => {}, async () => ({ ok: true }));
  const id = jobs.start({ query: 'пример', quickTest: true });
  while (!resolveSearch) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(await jobs.stop(id), true);
  await jobs.waitForIdle();
  assert.equal(jobs.get(id).status, 'cancelled');
  assert.equal(repo.entries.length, 0);
});

test('истёкшая CAPTCHA ставит задачу на паузу и продолжает её с сохранённой страницы', async () => {
  const repo = repository();
  let attempts = 0;
  let resumePage;
  const provider = {
    browser: { close: async () => {} },
    search: async (_query, _settings, hooks) => {
      attempts += 1;
      if (attempts === 1) {
        hooks.onSearchPage(3);
        const error = new Error('Время ручного подтверждения CAPTCHA истекло');
        error.code = 'CAPTCHA_TIMEOUT';
        throw error;
      }
      resumePage = _query.resumePage;
      return { candidates: [], withinDuplicates: 0 };
    },
  };
  const jobs = new JobManager(repo, provider, { error() {} }, () => {}, async () => ({ ok: true }));
  const id = jobs.start({ query: 'пример' });
  await jobs.waitForIdle();
  assert.equal(jobs.get(id).status, 'paused_captcha');
  assert.equal(jobs.get(id).query.resumePage, 3);
  assert.equal(await jobs.resume(id), true);
  await jobs.waitForIdle();
  assert.equal(resumePage, 3);
  assert.equal(jobs.get(id).status, 'completed');
});

test('при непройденной CAPTCHA сохраняет найденное с тональностью и дополняет после возобновления', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-paused-'));
  const db = openDatabase(path.join(folder, 'search.db'));
  try {
    const repo = new Repository(db);
    let attempt = 0;
    const make = (url, sentiment) => ({ url, normalized: url, title: 'Ромашка', date: '2026-10-01', description: 'Ромашка открыла завод', sentiment });
    const provider = { browser: { close: async () => {} }, search: async (query, _settings, hooks) => {
      attempt += 1;
      hooks.onSearchPage(attempt === 1 ? 2 : 3);
      return { candidates: attempt === 1 ? [make('https://example.org/one', 'positive')] : [make('https://example.org/one', 'positive'), make('https://example.org/two', 'negative')], withinDuplicates: 0, pausedCaptcha: attempt === 1 };
    } };
    const jobs = new JobManager(repo, provider, { error() {} }, () => {}, async () => ({ ok: true }));
    const id = jobs.start({ query: 'Ромашка' });
    await jobs.waitForIdle();
    assert.equal(jobs.get(id).status, 'paused_captcha');
    assert.equal(repo.historyById(id).results_count, 1);
    assert.equal(repo.allResults(id)[0].sentiment, 'positive');
    assert.equal(jobs.get(id).resultsCount, 1);
    const restarted = new JobManager(repo, provider, { error() {} }, () => {}, async () => ({ ok: true }));
    assert.equal(await restarted.resume(String(repo.historyById(id).id)), true);
    await restarted.waitForIdle();
    assert.equal(restarted.get(id).status, 'completed');
    assert.equal(repo.historyById(id).results_count, 2);
    assert.deepEqual(repo.allResults(id).map(row => row.sentiment).sort(), ['negative', 'positive']);
  } finally { db.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});
