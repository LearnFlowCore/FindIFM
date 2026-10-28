const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTarget, parseTargetSpec } = require('../src/social/identify');
const { parseGroup, parseWall, pickGroup, callApi } = require('../src/social/vk');
const { parsePreview, parseCompactNumber, fetchMemberCount } = require('../src/social/telegram');
const { diagnoseTarget, runDiagnostics } = require('../src/social/diagnostics');
const { SocialStore } = require('../src/social/store');
const { VK_GROUP, VK_WALL, TELEGRAM_HTML } = require('../src/social/selfcheck');

const COLLECTED_AT = '2026-10-26T00:00:00.000Z';

function vkResponse(payload) {
  return async (url) => {
    const method = url.split('/').pop();
    return { ok: true, status: 200, json: async () => payload[method] };
  };
}
function telegramResponse({ html = TELEGRAM_HTML, status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300, status, url: 'https://t.me/s/test',
    headers: { get: () => 'text/html; charset=utf-8' }, text: async () => html,
  });
}

test('извлекает идентификаторы VK и Telegram из ссылок', () => {
  assert.deepEqual(
    { platform: parseTarget('https://vk.com/club42').platform, identifier: parseTarget('https://vk.com/club42').identifier },
    { platform: 'vk', identifier: '42' },
  );
  assert.equal(parseTargetSpec('vk=https://vk.com/public99').identifier, '99');
  assert.equal(parseTarget('https://vk.com/wall-42_7').identifier, '42');
  assert.equal(parseTargetSpec('telegram=@test_channel').identifier, 'test_channel');
  assert.equal(parseTarget('https://t.me/s/test_channel').identifier, 'test_channel');
  assert.equal(parseTarget('https://t.me/test_channel/42').identifier, 'test_channel');
  assert.throws(() => parseTarget('https://t.me/+abcdefgh'), /приватный/);
  assert.throws(() => parseTarget('https://example.com/test'), /только VK и Telegram|Укажите площадку/);
});

test('разбирает подписчиков и просмотры VK, не подменяя нулём', () => {
  const group = parseGroup(pickGroup(VK_GROUP.response), COLLECTED_AT);
  assert.equal(group.subscribers.value, 1234);
  assert.equal(group.subscribers.available, true);
  const posts = parseWall(VK_WALL.response, COLLECTED_AT);
  assert.equal(posts[0].views.value, 77);
  assert.equal(posts[0].likes, 3);
  assert.equal(posts[1].views.available, false);
  assert.equal(posts[1].views.value, null);
  assert.equal(posts[1].url, 'https://vk.com/wall-42_8');
});

test('разбирает Telegram: подписчики и сокращённые просмотры', () => {
  const preview = parsePreview(TELEGRAM_HTML, 'test', COLLECTED_AT);
  assert.equal(preview.name, 'Тестовый канал');
  assert.equal(preview.subscribers.value, 1500);
  assert.equal(preview.subscribers.approximate, true);
  assert.equal(preview.posts.length, 2);
  assert.equal(preview.posts[0].views.value, 1200);
  assert.equal(preview.posts[0].views.approximate, true);
  assert.equal(preview.posts[0].views.raw, '1.2K');
  assert.equal(preview.posts[1].views.available, false);
  assert.equal(parseCompactNumber('0').value, 0);
  assert.equal(parseCompactNumber(''), null);
});

test('пустой и изменённый HTML не считается успешным сбором', () => {
  assert.throws(() => parsePreview('', 'test'), error => error.code === 'EMPTY_RESPONSE');
  assert.throws(() => parsePreview('<html><body>Нет данных</body></html>', 'test'), error => error.code === 'PARSE_ERROR');
});

test('ошибки авторизации и лимитов классифицируются, токен не утекает', async () => {
  const response = async () => ({ ok: true, status: 200, json: async () => ({ error: { error_code: 5, error_msg: 'token SECRET123 rejected' } }) });
  await assert.rejects(callApi('groups.getById', {}, { token: 'SECRET123', fetchImpl: response }),
    error => error.code === 'AUTH_INVALID' && !error.message.includes('SECRET123'));
  const limited = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(callApi('groups.getById', {}, { token: 'SECRET123', fetchImpl: limited }), error => error.code === 'RATE_LIMITED');
  const telegramLimited = async () => ({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests' }) });
  await assert.rejects(fetchMemberCount('test', { token: 'SECRET123', fetchImpl: telegramLimited }), error => error.code === 'RATE_LIMITED');
  const telegramAuth = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) });
  await assert.rejects(fetchMemberCount('test', { token: 'SECRET123', fetchImpl: telegramAuth }), error => error.code === 'AUTH_INVALID');
});

test('тайм-ауты и сетевые ошибки различаются', async () => {
  const timeout = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(callApi('groups.getById', {}, { token: 'token-12345678', fetchImpl: timeout }), error => error.code === 'NETWORK_TIMEOUT');
  const connectTimeout = async () => { throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); };
  await assert.rejects(callApi('groups.getById', {}, { token: 'token-12345678', fetchImpl: connectTimeout }), error => error.code === 'NETWORK_TIMEOUT');
  const offline = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
  await assert.rejects(callApi('groups.getById', {}, { token: 'token-12345678', fetchImpl: offline }), error => error.code === 'NETWORK_ERROR');
});

test('VK без токена помечается AUTH_MISSING и не выдаёт фиктивные метрики', async () => {
  const result = await diagnoseTarget(parseTarget('https://vk.com/club42'), { token: '' });
  assert.equal(result.status, 'failed');
  assert.equal(result.metrics.subscribers.available, false);
  assert.equal(result.metrics.subscribers.value, null);
  assert.match(result.metrics.subscribers.reason, /VK_ACCESS_TOKEN/);
  assert.equal(result.errors[0].code, 'AUTH_MISSING');
  assert.equal(result.postsWithViews, 0);
});

test('диагностика Telegram сохраняет реальные значения в хранилище и не дублирует записи', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-social-store-'));
  const store = new SocialStore(path.join(folder, 'social.sqlite'));
  try {
    const target = parseTarget('https://t.me/s/test');
    const first = await diagnoseTarget(target, { fetchImpl: telegramResponse(), store, telegramToken: '' });
    assert.equal(first.status, 'partial');
    assert.equal(first.metrics.subscribers.value, 1500);
    assert.equal(first.postsWithViews, 1);
    const community = store.readCommunity('telegram', 'test');
    assert.equal(community.subscribers, 1500);
    let posts = store.readPosts('telegram', 'test');
    assert.equal(posts.length, 2);
    assert.equal(posts.find(post => post.external_id === '10').views, 1200);
    assert.equal(posts.find(post => post.external_id === '9').views, null);
    assert.equal(first.persistence.posts.inserted, 2);
    const second = await diagnoseTarget(target, { fetchImpl: telegramResponse(), store, telegramToken: '' });
    assert.equal(second.persistence.posts.inserted, 0);
    assert.equal(second.persistence.posts.updated, 2);
    posts = store.readPosts('telegram', 'test');
    assert.equal(posts.length, 2);
  } finally {
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('VK: значения прослеживаются от ответа API до хранилища', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-social-vk-'));
  const store = new SocialStore(path.join(folder, 'social.sqlite'));
  try {
    const payload = { 'groups.getById': VK_GROUP, 'wall.get': VK_WALL };
    const result = await diagnoseTarget(parseTarget('https://vk.com/club42'), { token: 'token-12345678', fetchImpl: vkResponse(payload), store });
    assert.equal(result.status, 'partial');
    assert.equal(result.metrics.subscribers.value, 1234);
    assert.equal(result.postsWithViews, 1);
    assert.equal(store.readCommunity('vk', '42').subscribers, 1234);
    assert.equal(store.readPosts('vk', '42').find(post => post.external_id === '7').views, 77);
  } finally {
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('успех засчитывается, когда доступны подписчики и просмотры всех публикаций', async () => {
  const html = TELEGRAM_HTML.replace('<time datetime="2026-10-19T10:00:00+00:00"></time></div></div>', '<time datetime="2026-10-19T10:00:00+00:00"></time><span class="tgme_widget_message_views">900</span></div></div>');
  const result = await diagnoseTarget(parseTarget('https://t.me/s/test'), { fetchImpl: telegramResponse({ html }), telegramToken: '' });
  assert.equal(result.postsChecked, 2);
  assert.equal(result.postsWithViews, 2);
  assert.equal(result.status, 'success');
});

test('локальный режим не обращается к сети и проверяет парсеры', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('сеть запрещена в локальном режиме'); };
  try {
    const report = await runDiagnostics({ mode: 'local' });
    assert.equal(report.status, 'ok');
    assert.equal(report.mode, 'local');
    assert.ok(report.checks.length >= 8);
    assert.ok(report.checks.every(check => check.passed));
  } finally { global.fetch = originalFetch; }
});

test('живой режим без реальных целей возвращает NO_TARGETS_CONFIGURED', async () => {
  const report = await runDiagnostics({ mode: 'live', targets: [] });
  assert.equal(report.status, 'NO_TARGETS_CONFIGURED');
  assert.deepEqual(report.results, []);
  assert.ok(report.instructions.length > 0);
});
