const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery, buildYandexText, textMatches } = require('../src/utils/query');

test('извлекает дату и удаляет ее из поискового текста', () => {
  const query = parseQuery({ query: 'Иванов совершил действие 15.03.2024', period: 'week' });
  assert.equal(query.text, 'Иванов совершил действие');
  assert.equal(query.extractedDate, '2024-03-15');
  assert.equal(query.from, '2024-03-08');
});
test('точная фраза запрещает извлечение даты', () => {
  const query = parseQuery({ query: 'Иванов 15.03.2024', exactPhrase: true });
  assert.equal(query.text, 'Иванов 15.03.2024');
  assert.equal(query.extractedDate, null);
  assert.equal(buildYandexText(query), '"Иванов 15.03.2024"');
});
test('добавляет доменные операторы Яндекса', () => {
  const query = parseQuery({ query: 'тест', whitelist: ['lenta.ru', 'ria.ru'], blacklist: ['vk.com'] });
  assert.equal(buildYandexText(query), 'тест (site:lenta.ru | site:ria.ru) -site:vk.com');
});
test('проверяет все слова или точную фразу после нормализации', () => {
  assert.equal(textMatches('Иванов: выполнил действие.', parseQuery({ query: 'Иванов действие' })), true);
  assert.equal(textMatches('Иванов что-то выполнил', parseQuery({ query: 'Иванов выполнил', exactPhrase: true })), false);
});

test('учитывает русские словоформы при проверке ключевых слов', () => {
  const query = parseQuery({ query: 'Министерство образования ЛНР' });
  assert.equal(textMatches('При содействии министерства образования и науки ЛНР', query), true);
});

test('не усекает аббревиатуры при проверке вариантов запроса', () => {
  const query = parseQuery({ query: 'РЦВДО ПИОНЕР' });
  assert.deepEqual(query.acronyms, ['рцвдо']);
  assert.equal(textMatches('РЦВДО «Пионер» открыл набор', query), true);
  assert.equal(textMatches('РЦВ «Пионер» открыл набор', query), false);
});
