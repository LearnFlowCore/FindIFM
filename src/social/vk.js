// ВКонтакте: официальное API groups.getById и wall.get.
const { DiagnosticError, classifyHttpStatus, toDiagnosticError } = require('./errors');

const API = 'https://api.vk.com/method';
const VK_ERRORS = {
  5: ['AUTH_INVALID', 'Токен ВКонтакте отклонён или истёк.'],
  6: ['RATE_LIMITED', 'ВКонтакте ограничил частоту запросов.'],
  7: ['ACCESS_DENIED', 'Нет прав на запрошенные данные.'],
  9: ['RATE_LIMITED', 'Слишком много однотипных запросов.'],
  14: ['CHALLENGE_OR_CAPTCHA', 'ВКонтакте требует проверку (captcha).'],
  15: ['ACCESS_DENIED', 'Доступ к запрошенным данным запрещён.'],
  18: ['NOT_FOUND', 'Сообщество или запись не найдены.'],
  100: ['INVALID_IDENTIFIER', 'Некорректный идентификатор сообщества.'],
  113: ['INVALID_IDENTIFIER', 'Неверный идентификатор пользователя или сообщества.'],
  203: ['ACCESS_DENIED', 'Доступ к сообществу ограничен.'],
};

const redact = (text, token) => token ? String(text).split(token).join('[redacted]') : String(text);

function apiError(error, token) {
  const [code, message] = VK_ERRORS[error?.error_code] || ['UNKNOWN', 'ВКонтакте вернул ошибку API.'];
  const detail = redact(String(error?.error_msg || '').slice(0, 300), token);
  return new DiagnosticError(code, detail ? `${message} ${detail}` : message, { apiErrorCode: error?.error_code });
}

async function callApi(method, params, options = {}) {
  const { token, fetchImpl = fetch, timeoutMs = 15000, apiVersion = process.env.VK_API_VERSION || '5.199' } = options;
  if (!token) throw new DiagnosticError('AUTH_MISSING', 'Не задан VK_ACCESS_TOKEN: официальное API ВКонтакте недоступно.');
  const body = new URLSearchParams({ ...params, access_token: token, v: apiVersion });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response, payload;
  try {
    response = await fetchImpl(`${API}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: controller.signal,
    });
    if (!response.ok) {
      throw new DiagnosticError(classifyHttpStatus(response.status), `ВКонтакте вернул HTTP ${response.status}.`, { httpStatus: response.status });
    }
    try { payload = await response.json(); }
    catch { throw new DiagnosticError('PARSE_ERROR', 'Ответ ВКонтакте не является корректным JSON.'); }
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    const wrapped = toDiagnosticError(error);
    wrapped.message = redact(wrapped.message, token);
    throw wrapped;
  } finally { clearTimeout(timer); }
  if (payload?.error) throw apiError(payload.error, token);
  return payload?.response;
}

function pickGroup(response) {
  const groups = Array.isArray(response) ? response : response?.groups;
  const group = Array.isArray(groups) ? groups[0] : null;
  if (!group) throw new DiagnosticError('NOT_FOUND', 'Сообщество ВКонтакте не найдено.');
  return group;
}

function parseGroup(group, collectedAt) {
  const count = Number(group.members_count);
  const known = Number.isFinite(count);
  return {
    name: group.name || null,
    url: group.screen_name ? `https://vk.com/${group.screen_name}` : `https://vk.com/club${group.id}`,
    numericId: group.id ?? null,
    subscribers: {
      available: known, value: known ? count : null, raw: known ? String(count) : null,
      approximate: false, source: 'vk_api.groups.getById', collectedAt,
      reason: known ? null : 'В ответе groups.getById отсутствует members_count.',
    },
  };
}

function parseWall(response, collectedAt) {
  const items = Array.isArray(response?.items) ? response.items : [];
  if (!items.length) throw new DiagnosticError('EMPTY_RESPONSE', 'В сообществе нет доступных публикаций.');
  return items.slice(0, 10).map(item => {
    const views = item?.views?.count;
    const viewsKnown = Number.isFinite(Number(views)) && views !== null && views !== undefined;
    const id = item?.id;
    return {
      externalId: id !== undefined ? String(id) : null,
      url: id !== undefined && item?.owner_id !== undefined ? `https://vk.com/wall${item.owner_id}_${id}` : null,
      publishedAt: item?.date ? new Date(item.date * 1000).toISOString() : null,
      views: {
        available: viewsKnown, value: viewsKnown ? Number(views) : null, raw: viewsKnown ? String(views) : null,
        approximate: false, source: 'vk_api.wall.get', collectedAt,
        reason: viewsKnown ? null : 'У публикации нет поля views.count.',
      },
      likes: Number.isFinite(item?.likes?.count) ? item.likes.count : null,
      comments: Number.isFinite(item?.comments?.count) ? item.comments.count : null,
      reposts: Number.isFinite(item?.reposts?.count) ? item.reposts.count : null,
    };
  });
}

async function collectCommunity(target, options = {}) {
  const collectedAt = new Date().toISOString();
  const stages = [];
  const api = { ...options, token: options.token ?? process.env.VK_ACCESS_TOKEN };
  stages.push({ stage: 'auth', status: api.token ? 'ok' : 'missing', detail: api.token ? 'Токен VK задан.' : 'VK_ACCESS_TOKEN не задан.' });
  const groupResponse = await callApi('groups.getById', { group_ids: target.identifier, fields: 'members_count,description,status' }, api);
  const group = pickGroup(groupResponse);
  const parsed = parseGroup(group, collectedAt);
  stages.push({ stage: 'community', status: 'ok', httpStatus: 200, detail: `members_count=${parsed.subscribers.available ? parsed.subscribers.value : 'нет'}` });
  let posts = [];
  try {
    const wall = await callApi('wall.get', { owner_id: `-${group.id}`, count: 10, filter: 'owner' }, api);
    posts = parseWall(wall, collectedAt);
    stages.push({ stage: 'posts', status: 'ok', httpStatus: 200, detail: `Записей: ${posts.length}` });
  } catch (error) {
    const normalized = toDiagnosticError(error);
    stages.push({ stage: 'posts', status: 'error', code: normalized.code, detail: normalized.message });
    throw Object.assign(normalized, { partial: { community: parsed, stages } });
  }
  return { community: parsed, posts, stages, collectedAt };
}

module.exports = { collectCommunity, callApi, parseGroup, parseWall, pickGroup, apiError, redact };
