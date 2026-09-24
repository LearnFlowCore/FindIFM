const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDate, parseDate, resolveDateRange } = require('../src/utils/date');

test('поддерживает три формата даты', () => {
  assert.equal(parseDate('01.02.2025'), '2025-02-01');
  assert.equal(parseDate('2025-02-01'), '2025-02-01');
  assert.equal(parseDate('1 февраля 2025'), '2025-02-01');
  assert.equal(parseDate('31.02.2025'), null);
});
test('возвращает совпавший фрагмент', () => assert.deepEqual(extractDate('событие 15.03.2024'), { date: '2024-03-15', match: '15.03.2024' }));
test('ручной диапазон имеет наивысший приоритет', () => assert.deepEqual(
  resolveDateRange({ period: 'week', from: '2020-01-01', to: '2020-01-03', extractedDate: '2024-03-15' }),
  { from: '2020-01-01', to: '2020-01-03', within: null },
));
test('неделя вокруг извлеченной даты симметрична', () => assert.deepEqual(
  resolveDateRange({ period: 'week', extractedDate: '2024-03-15' }),
  { from: '2024-03-08', to: '2024-03-22', within: null },
));
test('период без даты передается через within', () => assert.deepEqual(
  resolveDateRange({ period: 'month' }), { from: null, to: null, within: '87' },
));
