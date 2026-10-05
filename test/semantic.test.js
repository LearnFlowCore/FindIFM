const test = require('node:test');
const assert = require('node:assert/strict');
const { rank, summarize, cosine } = require('../src/semantic');
const { parseQuery } = require('../src/utils/query');
const { YandexHTMLProvider } = require('../src/search/provider');
const { openDatabase } = require('../src/db');
const { Repository } = require('../src/repository');
const { normalizeRow } = require('../public/saved');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server');

test('семантический режим допускает страницу без буквального совпадения', async () => {
  const query = parseQuery({ query: 'закрытие школы', semantic: true, deepPages: 0 });
  assert.equal(query.semantic, true);
  const browser = {
    collect: async () => [{ url: 'https://example.org/news', title: 'Сообщение', snippet: 'Новость' }],
    inspect: async () => ({ title: 'Сообщение', text: 'Учреждение приостановило работу', description: 'Приостановка работы' }),
  };
  const { candidates } = await new YandexHTMLProvider(browser, { warn() {} }).search(query, { maxDurationMinutes: 1, maxResults: 10 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, 'Учреждение приостановило работу');
});

test('эмбеддинги ранжируют выдержки; сводка содержит ссылки на источники', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    if (url.endsWith('/embeddings')) return Response.json({ data: body.input.map((text, index) => ({ index,
      embedding: /закрытие|приостановило/i.test(text) ? [1, 0] : [0, 1] })) });
    return Response.json({ choices: [{ message: { content: 'Работа приостановлена [1].' } }] });
  };
  try {
    const found = await rank('закрытие', [
      { url: 'https://example.org/a', text: 'Совсем другая тема' },
      { url: 'https://example.org/b', text: 'Учреждение приостановило работу' },
    ]);
    assert.equal(found[0].url, 'https://example.org/b');
    assert.equal(found[0].evidence, 'Учреждение приостановило работу');
    assert.equal(cosine([1, 0], [0, 1]), 0);
    const result = await summarize('Что произошло?', [{ url: found[0].url, evidence: found[0].evidence }]);
    assert.match(result.answer, /\[1\]/);
    assert.deepEqual(result.sources.map(source => source.url), ['https://example.org/b']);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = originalKey;
  }
});

test('выдержки поисковых результатов сохраняются в SQLite и браузерном архиве', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-semantic-'));
  try {
    const db = openDatabase(path.join(directory, 'test.db'));
    const repository = new Repository(db);
    repository.addResults('job', [{ url: 'https://example.org/', urlNormalized: 'https://example.org/',
      domain: 'example.org', title: 'Сообщение', date: null, description: 'Описание', query: 'Закрытие',
      searchDate: '', searchRunDate: '', status: 'новый', snippetMatch: 0,
      evidence: 'Учреждение приостановило работу', semanticScore: 0.83 }]);
    const row = repository.allResults('job')[0];
    assert.equal(row.evidence, 'Учреждение приостановило работу');
    assert.equal(row.semantic_score, 0.83);
    assert.equal(normalizeRow(row).evidence, row.evidence);
    db.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('API объясняет, что для поиска по смыслу и сводки нужен ключ модели', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-semantic-api-'));
  const previous = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  let service;
  try {
    service = await startServer({ dataRoot: directory, host: '127.0.0.1', port: 0 });
    for (const [route, body] of [['/api/search', { semantic: true, query: 'школа' }], ['/api/semantic/summary', { question: 'Что произошло?', rows: [] }]]) {
      const response = await fetch(`${service.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /AI_API_KEY/);
    }
  } finally {
    if (service) await service.stop();
    if (previous !== undefined) process.env.AI_API_KEY = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
