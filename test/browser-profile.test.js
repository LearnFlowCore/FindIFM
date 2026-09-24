const test = require('node:test');
const assert = require('node:assert/strict');
const { YandexBrowser } = require('../src/browser');

test('временный профиль уникален для каждого экземпляра парсера', () => {
  const first = new YandexBrowser({}, {}, 'C:\\temp\\mention-monitor');
  const second = new YandexBrowser({}, {}, 'C:\\temp\\mention-monitor');
  assert.notEqual(first.temporaryProfile, second.temporaryProfile);
  assert.match(first.temporaryProfile, /browser-profile-\d+-[a-f0-9]+$/);
});
