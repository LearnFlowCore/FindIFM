// Разбор ссылок и идентификаторов сообществ VK и Telegram.
const { DiagnosticError } = require('./errors');

const VK_HOST = /(^|\.)vk\.(com|ru)$/i;
const TG_HOST = /(^|\.)(t\.me|telegram\.me)$/i;
const SAFE_SLUG = /^[A-Za-z0-9._-]{2,64}$/;

function toUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new DiagnosticError('INVALID_URL', 'Пустая ссылка на сообщество.');
  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try { return new URL(candidate); }
  catch { throw new DiagnosticError('INVALID_URL', 'Неверный формат URL.', { value: text }); }
}

function parseVk(value) {
  const text = String(value || '').trim();
  const url = toUrl(/^[A-Za-z0-9._-]+$/.test(text) && !text.includes('.') ? `https://vk.com/${text}` : text);
  if (!VK_HOST.test(url.hostname)) throw new DiagnosticError('INVALID_URL', 'Ссылка не относится к ВКонтакте.', { value: url.href });
  const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
  if (!parts.length) throw new DiagnosticError('INVALID_IDENTIFIER', 'В ссылке VK нет названия сообщества.');
  const first = parts[0];
  if (first === 'away' || first === 'wall' || first === 'photo' || first === 'video' || first === 'story') {
    throw new DiagnosticError('INVALID_IDENTIFIER', 'Ссылка ведёт на запись или профиль, а не на сообщество.', { value: url.href });
  }
  if (/^(id|im|market)(\d+)?$/i.test(first) && !/^(club|public|event)\d+$/i.test(first)) {
    throw new DiagnosticError('INVALID_IDENTIFIER', 'Личные профили VK не проверяются как сообщества.', { value: url.href });
  }
  const numeric = first.match(/^(?:club|public|event)(\d+)$/i);
  if (numeric) return { platform: 'vk', identifier: numeric[1], kind: 'id', communityUrl: `https://vk.com/${first}`, screenName: null };
  const wall = first.match(/^wall(-?\d+)_(\d+)$/i);
  if (wall) return { platform: 'vk', identifier: wall[1].replace('-', ''), kind: 'id', communityUrl: `https://vk.com/${first}`, screenName: null };
  if (!SAFE_SLUG.test(first)) throw new DiagnosticError('INVALID_IDENTIFIER', 'В ссылке VK недопустимое имя сообщества.', { value: first });
  return { platform: 'vk', identifier: first, kind: 'screen_name', communityUrl: `https://vk.com/${first}`, screenName: first };
}

function parseTelegram(value) {
  const text = String(value || '').trim();
  const url = toUrl(/^@/.test(text) || /^[A-Za-z0-9_]+$/.test(text) ? `https://t.me/${text.replace(/^@/, '')}` : text);
  if (!TG_HOST.test(url.hostname)) throw new DiagnosticError('INVALID_URL', 'Ссылка не относится к Telegram.', { value: url.href });
  const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
  if (parts[0] === 's') parts.shift();
  if (!parts.length) throw new DiagnosticError('INVALID_IDENTIFIER', 'В ссылке Telegram нет имени канала.');
  const raw = parts[0];
  if (raw.startsWith('+') || raw === 'joinchat') {
    throw new DiagnosticError('INVALID_IDENTIFIER', 'Приглашение в приватный чат нельзя проверить публично.', { value: url.href });
  }
  const username = raw.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{3,64}$/.test(username)) {
    throw new DiagnosticError('INVALID_IDENTIFIER', 'Недопустимое имя публичного канала Telegram.', { value: username });
  }
  return {
    platform: 'telegram', identifier: username, kind: 'username',
    communityUrl: `https://t.me/${username}`, previewUrl: `https://t.me/s/${username}`,
  };
}

// platform необязателен, если значение — полный URL или @username.
function parseTarget(value, platform) {
  const text = String(value || '').trim();
  if (!text) throw new DiagnosticError('INVALID_URL', 'Пустая цель диагностики.');
  const looksUrl = /^https?:\/\//i.test(text) || /(^|\.)(vk\.(com|ru)|t\.me|telegram\.me)(\/|$)/i.test(text);
  if (looksUrl) {
    const url = toUrl(text);
    if (VK_HOST.test(url.hostname)) return parseVk(url.href);
    if (TG_HOST.test(url.hostname)) return parseTelegram(url.href);
    throw new DiagnosticError('INVALID_URL', 'Поддерживаются только VK и Telegram.', { value: text });
  }
  if (platform === 'vk') return parseVk(`https://vk.com/${text.replace(/^@/, '')}`);
  if (platform === 'telegram') return parseTelegram(`https://t.me/${text.replace(/^@/, '')}`);
  if (text.startsWith('@')) return parseTelegram(text);
  throw new DiagnosticError('INVALID_URL', 'Укажите площадку: vk=… или telegram=….', { value: text });
}

// "vk=https://…" или "telegram=@name"
function parseTargetSpec(spec) {
  const text = String(spec || '').trim();
  const match = text.match(/^(vk|telegram)\s*=\s*(.+)$/i);
  if (!match) return parseTarget(text);
  return parseTarget(match[2], match[1].toLowerCase());
}

module.exports = { parseVk, parseTelegram, parseTarget, parseTargetSpec, VK_HOST, TG_HOST };
