const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { Repository } = require('../src/repository');

test('встроенный SQLite сохраняет настройки и очищает связанные данные', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-monitor-db-'));
  const db = openDatabase(path.join(folder, 'test.db'));
  try {
    const repo = new Repository(db);
    repo.setSettings({ maxPages: 7 });
    assert.equal(repo.settings().maxPages, 7);

    const query = { original: 'тест', extractedDate: null, period: null, from: null, to: null, whitelist: [], blacklist: [] };
    repo.addHistory('job-1', query);
    repo.addResults('job-1', [{
      url: 'https://example.com/a', urlNormalized: 'https://example.com/a', domain: 'example.com', title: 'Тест',
      date: null, description: '', query: 'тест', searchDate: '2026-01-01', searchRunDate: '2026-01-01', status: 'новый', snippetMatch: 0,
    }]);
    repo.finishHistory('job-1', 'completed', 1, 0);
    const listed = repo.results();
    assert.equal(listed.groups[0].query, 'тест');
    assert.equal(listed.groups[0].count, 1);
    assert.equal(listed.groups[0].domains, 1);
    assert.equal(repo.deleteResult(listed.rows[0].id), true);
    assert.equal(repo.results().total, 0);
    assert.equal(repo.history()[0].results_count, 0);
    assert.equal(repo.deleteResult(999999), false);
    repo.clearHistory();
    assert.equal(repo.history().length, 0);
    assert.equal(repo.allResults().length, 0);
  } finally {
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
