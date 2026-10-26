// Поиск по российским соцсетям и сетям стран СНГ.
// У VK, OK, MAX, Telegram и других нет открытого поиска без ключей и авторизации,
// поэтому сети ищутся через обычную веб-выдачу с ограничением site:, а ссылки
// затем помечаются сетью, автором и категорией. Все критерии запроса
// (слова, даты, ключевые фразы, длина, медиа, тональность) применяются дальше
// в провайдере — здесь только реестр сетей и разбор ссылок.
const SOCIAL_SOURCES = {
  vk: { label: 'ВКонтакте', hosts: ['vk.com', 'vk.ru'] },
  ok: { label: 'Одноклассники', hosts: ['ok.ru'] },
  max: { label: 'MAX', hosts: ['max.ru'] },
  telegram: { label: 'Telegram', hosts: ['t.me', 'telegram.me'] },
  viber: { label: 'Viber', hosts: ['viber.com', 'chats.viber.com'] },
  dzen: { label: 'Дзен', hosts: ['dzen.ru', 'zen.yandex.ru'] },
  rutube: { label: 'Rutube', hosts: ['rutube.ru'] },
  instagram: { label: 'Instagram', hosts: ['instagram.com'] },
  tiktok: { label: 'TikTok', hosts: ['tiktok.com'] },
  youtube: { label: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  facebook: { label: 'Facebook', hosts: ['facebook.com', 'fb.com'] },
};
const SOCIAL_KEYS = Object.keys(SOCIAL_SOURCES);
// Пресеты набора сетей для интерфейса и запросов.
const SOCIAL_PRESETS = {
  ru: ['vk', 'ok', 'max'],
  cis: ['telegram', 'viber', 'ok', 'vk'],
  all: SOCIAL_KEYS.slice(),
};

function hostMatches(hostname, domain) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return host === domain || host.endsWith(`.${domain}`);
}

function socialSource(value) {
  let hostname;
  try { hostname = new URL(value).hostname; } catch { return null; }
  for (const key of SOCIAL_KEYS) {
    if (SOCIAL_SOURCES[key].hosts.some(domain => hostMatches(hostname, domain))) return key;
  }
  return null;
}

function normalizeKeys(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  return [...new Set(list.map(item => String(item).trim().toLowerCase()).filter(key => SOCIAL_KEYS.includes(key)))];
}

// Один запрос на все выбранные сети: Яндекс корректно раскрывает (site:a | site:b).
function socialQueryText(query, keys = SOCIAL_KEYS) {
  const selected = normalizeKeys(keys);
  const sites = selected.flatMap(key => SOCIAL_SOURCES[key].hosts.map(domain => `site:${domain}`));
  if (!sites.length) return query.yandexText || '';
  return `${query.yandexText} (${sites.join(' | ')})`;
}

// Автор или канал из ссылки: vk.com/wall-1_2, ok.ru/group/1/topic/2,
// t.me/channel/123, youtube.com/@name и т.п.
function socialAuthor(value, key = socialSource(value)) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (key === 'telegram') return parts[0] || null;
    if (key === 'vk') return parts[0] || null;
    if (key === 'ok') return parts[0] === 'group' || parts[0] === 'profile' ? `${parts[0]}/${parts[1] || ''}`.replace(/\/$/, '') : parts[0] || null;
    if (key === 'youtube') {
      if (url.hostname.toLowerCase().endsWith('youtu.be')) return null;
      return ['channel', 'c', 'user', '@'].some(prefix => parts[0]?.startsWith(prefix)) ? parts[0] : parts[0] || null;
    }
    if (key === 'instagram' || key === 'tiktok') return parts[0] === 'p' || parts[0] === 'video' ? null : parts[0] || null;
    return parts[0] || null;
  } catch { return null; }
}

module.exports = { SOCIAL_SOURCES, SOCIAL_KEYS, SOCIAL_PRESETS, socialSource, socialQueryText, socialAuthor, normalizeKeys };
