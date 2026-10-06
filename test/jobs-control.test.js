const test = require('node:test');
const assert = require('node:assert/strict');
const { JobManager } = require('../src/jobs');

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
