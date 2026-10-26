const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDate, parseDate, formatDate, resolveDateRange } = require('../src/utils/date');

test('поддерживает три формата даты', () => {
  assert.equal(parseDate('01.02.2025'), '2025-02-01');
  assert.equal(parseDate('2025-02-01'), '2025-02-01');
  assert.equal(parseDate('1 февраля 2025'), '2025-02-01');
  assert.equal(parseDate('31.02.2025'), null);
});
test('поддерживает косые черты, короткие месяцы и дату в пути ссылки', () => {
  assert.equal(parseDate('15/03/2024'), '2024-03-15');
  assert.equal(parseDate('15 мар 2024'), '2024-03-15');
  assert.equal(parseDate('новость 15 мар. 2024 года'), '2024-03-15');
  assert.equal(parseDate('https://example.org/2024/03/15/news'), '2024-03-15');
});
test('понимает относительные даты относительно переданного момента', () => {
  const now = new Date('2026-10-26T10:00:00Z');
  assert.equal(extractDate('сегодня', now).date, '2026-10-26');
  assert.equal(extractDate('вчера', now).date, '2026-10-25');
  assert.equal(extractDate('позавчера', now).date, '2026-10-24');
  assert.equal(extractDate('3 дня назад', now).date, '2026-10-23');
  assert.equal(extractDate('неделю назад', now).date, '2026-10-19');
  assert.equal(extractDate('2 месяца назад', now).date, '2026-08-27');
});
test('форматирует известную дату для таблиц и выгрузок', () => {
  assert.equal(formatDate('2024-03-15'), '15.03.2024');
  assert.equal(formatDate('15.03.2024'), '15.03.2024');
  assert.equal(formatDate(''), '');
  assert.equal(formatDate('нет даты'), '');
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
