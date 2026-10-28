// Локальные самопроверки парсеров на фикстурах: сеть не используется.
const { parseGroup, parseWall, pickGroup, apiError, redact: vkRedact } = require('./vk');
const { parsePreview, parseCompactNumber, redact: telegramRedact } = require('./telegram');
const { parseTarget, parseTargetSpec } = require('./identify');

const VK_GROUP = { response: { groups: [{ id: 42, name: 'Тестовое сообщество', screen_name: 'test', members_count: 1234 }] } };
const VK_WALL = { response: { items: [
  { id: 7, owner_id: -42, date: 1700000000, views: { count: 77 }, likes: { count: 3 }, comments: { count: 1 }, reposts: { count: 2 } },
  { id: 8, owner_id: -42, date: 1700000100, likes: { count: 1 } },
] } };
const TELEGRAM_HTML = `<html><head><meta property="og:title" content="Тестовый канал"></head><body>
<section class="tgme_channel_info"><div class="tgme_channel_info_counters">
<div class="tgme_channel_info_counter"><span class="counter_value">1.5K</span><span class="counter_type">subscribers</span></div>
</div></section>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="test/10">
<time datetime="2026-10-20T10:00:00+00:00"></time><span class="tgme_widget_message_views">1.2K</span></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="test/9">
<time datetime="2026-10-19T10:00:00+00:00"></time></div></div>
</body></html>`;

function check(name, run) {
  try { const detail = run(); return { name, passed: true, detail: detail || 'ok' }; }
  catch (error) { return { name, passed: false, detail: error.message }; }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function code(run) {
  try { run(); return null; } catch (error) { return error.code || 'UNKNOWN'; }
}

function runSelfChecks() {
  return [
    check('VK: разбор club/public/event и wall-ссылок', () => {
      assert(parseTarget('https://vk.com/club42').identifier === '42', 'club42');
      assert(parseTargetSpec('vk=https://vk.com/public99').identifier === '99', 'public99');
      assert(parseTarget('https://vk.com/wall-42_7').identifier === '42', 'wall');
      assert(parseTargetSpec('vk=testcommunity').identifier === 'testcommunity', 'slug');
      return 'club42, public99, wall-42_7, slug';
    }),
    check('Telegram: разбор @username, /s/ и ссылки на пост', () => {
      assert(parseTarget('@test_channel').identifier === 'test_channel', '@');
      assert(parseTargetSpec('telegram=https://t.me/s/test_channel').identifier === 'test_channel', '/s/');
      assert(parseTarget('https://t.me/test_channel/42').identifier === 'test_channel', 'post');
      return 'username, /s/, post';
    }),
    check('VK: members_count из groups.getById', () => {
      const group = pickGroup(VK_GROUP.response);
      const parsed = parseGroup(group, '2026-10-26T00:00:00.000Z');
      assert(parsed.subscribers.available === true, 'available');
      assert(parsed.subscribers.value === 1234, 'value');
      assert(parsed.subscribers.source === 'vk_api.groups.getById', 'source');
      return '1234';
    }),
    check('VK: views.count, отсутствие просмотров не равно нулю', () => {
      const posts = parseWall(VK_WALL.response, '2026-10-26T00:00:00.000Z');
      assert(posts[0].views.available === true && posts[0].views.value === 77, 'views 77');
      assert(posts[1].views.available === false && posts[1].views.value === null, 'views null');
      assert(posts[0].likes === 3 && posts[0].comments === 1 && posts[0].reposts === 2, 'reactions');
      return '77 / null';
    }),
    check('Telegram: сокращённые счётчики помечаются приблизительными', () => {
      const compact = parseCompactNumber('1.2K');
      assert(compact.value === 1200 && compact.approximate === true && compact.raw === '1.2K', '1.2K');
      const exact = parseCompactNumber('1 234');
      assert(exact.value === 1234 && exact.approximate === false, '1 234');
      assert(parseCompactNumber('0').value === 0, 'zero');
      assert(parseCompactNumber('') === null, 'empty');
      return '1.2K≈1200, 1 234=1234, 0=0';
    }),
    check('Telegram: подписчики и просмотры из HTML предпросмотра', () => {
      const parsed = parsePreview(TELEGRAM_HTML, 'test', '2026-10-26T00:00:00.000Z');
      assert(parsed.name === 'Тестовый канал', 'name');
      assert(parsed.subscribers.available === true && parsed.subscribers.value === 1500, 'subscribers');
      assert(parsed.subscribers.approximate === true, 'subscribers approximate');
      assert(parsed.posts.length === 2, 'posts');
      assert(parsed.posts[0].views.value === 1200 && parsed.posts[0].views.approximate === true, 'views approximate');
      assert(parsed.posts[1].views.available === false && parsed.posts[1].views.value === null, 'views missing');
      return '1500 ≈, 1.2K ≈ 1200, вторая без просмотров';
    }),
    check('Telegram: пустой или изменённый HTML не считается успехом', () => {
      assert(code(() => parsePreview('<html><body>Ничего нет</body></html>', 'test')) === 'PARSE_ERROR', 'parse error');
      assert(code(() => parsePreview('', 'test')) === 'EMPTY_RESPONSE', 'empty');
      return 'PARSE_ERROR / EMPTY_RESPONSE';
    }),
    check('VK: ошибка токена классифицируется без раскрытия секрета', () => {
      const error = apiError({ error_code: 5, error_msg: 'User authorization failed: token SECRET123 invalid' }, 'SECRET123');
      assert(error.code === 'AUTH_INVALID', 'code');
      assert(!error.message.includes('SECRET123'), 'token leaked');
      return 'AUTH_INVALID, токен скрыт';
    }),
    check('Секреты вырезаются из диагностических сообщений', () => {
      assert(!vkRedact('token abcdefgh123', 'abcdefgh123').includes('abcdefgh123'), 'vk');
      assert(!telegramRedact('bot abcdefgh123', 'abcdefgh123').includes('abcdefgh123'), 'telegram');
      return 'redacted';
    }),
  ];
}

module.exports = { runSelfChecks, VK_GROUP, VK_WALL, TELEGRAM_HTML };
