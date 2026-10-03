const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanText, normalizePrices, sourceId, validHttpUrl } = require('../src/utils/content');
const { passesContentFilters } = require('../src/search/provider');

test('очищает пробелы и нормализует рублёвые цены', () => {
  assert.equal(cleanText('  строка\n  текста '), 'строка текста');
  assert.equal(normalizePrices('Цена 1234567,5 руб.'), 'Цена 1 234 567,50 ₽');
});

test('валидирует ссылки и извлекает идентификатор', () => {
  assert.equal(validHttpUrl('https://example.com/123456/article'), true);
  assert.equal(validHttpUrl('javascript:alert(1)'), false);
  assert.equal(sourceId('https://example.com/123456/article'), '123456');
});

test('применяет контентные фильтры', () => {
  const page = { text: 'важная новость экономики', category: 'Экономика', textLength: 1000, hasMedia: true };
  assert.equal(passesContentFilters(page, { includeKeywords: ['важная'], excludeKeywords: ['реклама'], category: 'экономика', minTextLength: 500, maxTextLength: 2000, media: 'present' }), true);
  assert.equal(passesContentFilters(page, { includeKeywords: [], excludeKeywords: ['новость'], category: '', minTextLength: 0, maxTextLength: 0, media: 'any' }), false);
});
