const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMention, countTones } = require('../public/reputation');

test('тональность оценивается по русскому заголовку и описанию публикации', () => {
  const rows = [
    { title: 'Компания получила награду', description: 'Достигнут успех' },
    { title: 'Жалобы на компанию', description: 'Проблемы и нарушения' },
    { title: 'Компания открыла офис', description: 'Новое подразделение' },
    { title: 'Рост и проблемы', description: '' },
  ];
  assert.deepEqual(rows.map(classifyMention), ['positive', 'negative', 'neutral', 'neutral']);
  assert.deepEqual(countTones(rows), { positive: 1, neutral: 2, negative: 1 });
});
