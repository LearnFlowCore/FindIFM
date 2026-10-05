const test = require('node:test');
const assert = require('node:assert/strict');

// Проверка состояния задачи не должна зависеть от установленного генератора файлов.
const exportPath = require.resolve('../src/export');
const exportModule = require.cache[exportPath];
require.cache[exportPath] = { id: exportPath, filename: exportPath, loaded: true, exports: { exportTxtSnapshot: () => 'FindIFM.txt' } };
const { JobManager } = require('../src/jobs');
if (exportModule) require.cache[exportPath] = exportModule;
else delete require.cache[exportPath];

test('задача передаёт время лимита и промежуточную публикацию до сохранения результатов', async () => {
  const repo = {
    addHistory() {}, addTaskLog() {}, updateTask() {}, addResults() {}, finishHistory() {},
    settings: () => ({ maxDurationMinutes: 2, maxPages: 1 }), hasUrl: () => false,
  };
  let snapshot;
  let deadlineAt;
  let manager;
  const provider = { search: async (_query, settings, hooks) => {
    deadlineAt = settings.deadlineAt;
    hooks.onCandidate({ url: 'https://example.org/story', normalized: 'https://example.org/story',
      title: 'Компания получила награду', description: 'История успеха', textLength: 150, hasMedia: true });
    snapshot = manager.get(jobId);
    return { candidates: [], withinDuplicates: 0 };
  } };
  manager = new JobManager(repo, provider, { error() {} }, () => {}, async () => ({ ok: true }));
  const jobId = manager.start({ query: 'Компания' });
  await manager.waitForIdle();
  assert.equal(snapshot.liveMatches, 1);
  assert.equal(snapshot.liveResults[0].domain, 'example.org');
  assert.equal(snapshot.liveResults[0].status, 'Предварительно');
  assert.ok(snapshot.serverNow >= snapshot.startedAt);
  assert.equal(snapshot.deadlineAt, deadlineAt);
  assert.equal(snapshot.deadlineAt - snapshot.serverNow > 119000, true);
  assert.deepEqual(manager.get(jobId).liveResults, []);
});
