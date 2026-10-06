const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationService } = require('../src/notifications');

test('CAPTCHA показывает системное уведомление независимо от уведомлений о завершении', async () => {
  const events = [];
  const service = new NotificationService(
    { settings: () => ({ notifyOnFinish: false, notifications: true }) },
    (message, event) => events.push({ message, event }),
    { warn() {} },
  );
  await service.send('captcha', 'Пройдите CAPTCHA');
  assert.deepEqual(events, [{ message: 'Пройдите CAPTCHA', event: 'captcha' }]);
});
