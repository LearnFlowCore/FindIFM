const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRow, csv } = require('../public/saved');

test('сохранённые результаты сохраняют ссылки и описание из завершённой задачи и SQLite', () => {
  const fresh = normalizeRow({ url: 'https://example.org/news', title: 'Заголовок', query: 'ключ', description: 'Полный текст', textLength: 480, hasMedia: 1 });
  const historic = normalizeRow({ url: 'https://example.org/old', query: 'ключ', text_length: 240, has_media: 0 });
  assert.deepEqual([fresh.text_length, fresh.has_media, historic.text_length, historic.has_media], [480, 1, 240, 0]);
  assert.equal(fresh.description, 'Полный текст');
  assert.equal(historic.url, 'https://example.org/old');
});

test('CSV архива содержит все результаты ключевого запроса и корректно экранирует текст', () => {
  const content = csv({ rows: [
    { query: 'ключ', url: 'https://example.org/1', title: 'Заголовок, "один"', description: '=опасное значение' },
    { query: 'другая фраза', url: 'https://example.org/2', title: 'Вторая публикация' },
  ] });
  assert.match(content, /"Заголовок, ""один"""/);
  assert.match(content, /"'=опасное значение"/);
  assert.match(content, /https:\/\/example.org\/2/);
  assert.equal(content.split('\r\n').length, 3);
});

test('CSV включает ключевую фразу сохранённого запуска, даже если она отсутствует в строке', () => {
  const content = csv({ query: 'общая фраза', rows: [{ url: 'https://example.org/news' }] });
  assert.match(content, /"общая фраза","https:\/\/example.org\/news"/);
});
