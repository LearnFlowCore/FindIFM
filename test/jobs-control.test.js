const test = require('node:test');
const assert = require('node:assert/strict');
const { JobManager } = require('../src/jobs');

function repository() {
  const entries = [];
  return {
    entries, addHistory() {}, addTaskLog() {}, updateTask() {},
    settings: () => ({ maxPages: 5, maxResults: 500, maxDurationMinutes: 30 }),
    addResults: (_id, rows) => entries.push(...rows),
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
