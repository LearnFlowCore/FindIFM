// Telegram: публичный веб-предпросмотр t.me/s/<канал> и Bot API getChatMemberCount.
const { DiagnosticError, classifyHttpStatus, toDiagnosticError } = require('./errors');

const PREVIEW = 'https://t.me/s/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const redact = (text, token) => token ? String(text).split(token).join('[redacted]') : String(text);

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// "1.2K" → 1200 приблизительно, "1 234" → 1234 точно, "" → null.
function parseCompactNumber(raw) {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const match = text.match(/^([0-9][0-9\s.,]*)\s*(K|M|B|тыс\.?|млн\.?|млрд\.?)?$/i);
  if (!match) return null;
  const suffix = (match[2] || '').toLowerCase();
  const multiplier = /^(k|тыс\.?)$/.test(suffix) ? 1000 : /^(m|млн\.?)$/.test(suffix) ? 1e6 : /^(b|млрд\.?)$/.test(suffix) ? 1e9 : 1;
  const digits = match[1].replace(/\s/g, '');
  if (multiplier > 1) {
    const value = Math.round(Number(digits.replace(',', '.')) * multiplier);
    return Number.isSafeInteger(value) ? { value, raw: text, approximate: true } : null;
  }
  const value = Number(digits.replace(/[.,]/g, ''));
  return Number.isSafeInteger(value) ? { value, raw: text, approximate: false } : null;
}

async function fetchPreview(identifier, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 15000 } = options;
  const url = `${PREVIEW}${identifier}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru,en;q=0.8' },
    });
    const html = await response.text();
    const meta = {
      url, finalUrl: response.url || url, httpStatus: response.status, durationMs: Date.now() - started,
      contentType: response.headers?.get?.('content-type') || '', size: html.length,
    };
    if (response.status === 404) throw new DiagnosticError('NOT_FOUND', 'Канал Telegram не найден.', meta);
    if (response.status === 403) throw new DiagnosticError('PUBLIC_PREVIEW_UNAVAILABLE', 'Telegram ограничил доступ к публичному предпросмотру (HTTP 403).', meta);
    if (response.status === 429) throw new DiagnosticError('RATE_LIMITED', 'Telegram ограничил частоту запросов (HTTP 429).', meta);
    if (!response.ok) throw new DiagnosticError(classifyHttpStatus(response.status), `Telegram вернул HTTP ${response.status}.`, meta);
    return { ...meta, html };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    const wrapped = toDiagnosticError(error);
    wrapped.details = { ...wrapped.details, url, durationMs: Date.now() - started };
    throw wrapped;
  } finally { clearTimeout(timer); }
}

function parsePreview(html, identifier, collectedAt = new Date().toISOString()) {
  const text = String(html || '');
  if (!text.trim()) throw new DiagnosticError('EMPTY_RESPONSE', 'Telegram вернул пустую страницу предпросмотра.');
  const hasPosts = /tgme_widget_message/.test(text);
  const hasChannel = /tgme_channel_info|tgme_page_title/.test(text);
  if (!hasPosts && /captcha|challenge|подтвердите|не робот/i.test(text)) {
    throw new DiagnosticError('CHALLENGE_OR_CAPTCHA', 'Telegram показал проверку доступа вместо канала.');
  }
  if (!hasChannel && !hasPosts) throw new DiagnosticError('PARSE_ERROR', 'Страница предпросмотра не содержит данных канала (возможно, изменился формат).');
  const name = decodeHtml(text.match(/<meta property="og:title" content="([^"]+)"/)?.[1]
    || text.match(/class="tgme_channel_info_header_title[^"]*"[^>]*>\s*<span[^>]*>([^<]+)</)?.[1] || '') || null;
  const counter = text.match(/counter_value">\s*([^<]+?)\s*<\/span>\s*<span class="counter_type">\s*subscribers\s*</i);
  const subscribersParsed = counter ? parseCompactNumber(decodeHtml(counter[1])) : null;
  const subscribers = subscribersParsed
    ? {
      available: true, value: subscribersParsed.value, raw: subscribersParsed.raw, approximate: subscribersParsed.approximate,
      source: 'telegram_public_preview', collectedAt,
      reason: subscribersParsed.approximate ? 'Счётчик на странице показан сокращённо; значение приблизительное.' : null,
    }
    : {
      available: false, value: null, raw: null, approximate: false, source: 'telegram_public_preview',
      collectedAt, reason: 'В публичном предпросмотре нет счётчика подписчиков.',
    };
  const posts = [];
  for (const block of text.split(/tgme_widget_message_wrap/).slice(1)) {
    const post = block.match(/data-post="([^"]+)"/)?.[1];
    if (!post) continue;
    const viewsRaw = block.match(/class="tgme_widget_message_views"[^>]*>\s*([^<]+?)\s*</)?.[1];
    const parsedViews = viewsRaw ? parseCompactNumber(decodeHtml(viewsRaw)) : null;
    const publishedAt = block.match(/<time[^>]*datetime="([^"]+)"/)?.[1] || null;
    posts.push({
      externalId: post.split('/').pop() || null,
      url: `https://t.me/${post}`,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      views: parsedViews
        ? {
          available: true, value: parsedViews.value, raw: parsedViews.raw, approximate: parsedViews.approximate,
          source: 'telegram_public_preview', collectedAt,
          reason: parsedViews.approximate ? 'Счётчик показан сокращённо, точное число недоступно.' : null,
        }
        : {
          available: false, value: null, raw: null, approximate: false, source: 'telegram_public_preview',
          collectedAt, reason: 'У публикации в предпросмотре нет счётчика просмотров.',
        },
    });
  }
  return { identifier, name, subscribers, posts, hasChannel, hasPosts };
}

async function fetchMemberCount(username, options = {}) {
  const { token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl = fetch, timeoutMs = 15000 } = options;
  if (!token) throw new DiagnosticError('AUTH_MISSING', 'Не задан TELEGRAM_BOT_TOKEN: официальный Bot API недоступен.');
  const collectedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/getChatMemberCount`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: `@${username}` }),
    });
    let data = null;
    try { data = await response.json(); } catch { /* разберём по статусу */ }
    const description = redact(String(data?.description || '').slice(0, 300), token);
    if (response.status === 401) throw new DiagnosticError('AUTH_INVALID', 'Telegram отклонил токен бота.', { httpStatus: 401 });
    if (response.status === 429) throw new DiagnosticError('RATE_LIMITED', 'Telegram ограничил частоту запросов Bot API.', { httpStatus: 429 });
    if (response.status === 403) throw new DiagnosticError('ACCESS_DENIED', description || 'Bot API запретил доступ к каналу.', { httpStatus: 403 });
    if (response.status === 404 || /chat not found|not found/i.test(description)) {
      throw new DiagnosticError('NOT_FOUND', description || 'Канал не найден в Bot API.', { httpStatus: response.status });
    }
    if (!response.ok || data?.ok === false) {
      throw new DiagnosticError(classifyHttpStatus(response.status), description || `Telegram Bot API вернул HTTP ${response.status}.`, { httpStatus: response.status });
    }
    const value = Number(data?.result);
    if (!Number.isSafeInteger(value)) throw new DiagnosticError('PARSE_ERROR', 'Bot API не вернул числовое количество участников.');
    return {
      available: true, value, raw: String(data.result), approximate: false,
      source: 'telegram_bot_api.getChatMemberCount', collectedAt, reason: null,
    };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    const wrapped = toDiagnosticError(error);
    wrapped.message = redact(wrapped.message, token);
    throw wrapped;
  } finally { clearTimeout(timer); }
}

async function collectCommunity(target, options = {}) {
  const collectedAt = new Date().toISOString();
  const stages = [];
  let preview = null;
  let previewError = null;
  let subscribers = null;
  let posts = [];
  try {
    const page = await fetchPreview(target.identifier, options);
    stages.push({ stage: 'preview', status: 'ok', httpStatus: page.httpStatus, finalUrl: page.finalUrl, durationMs: page.durationMs, size: page.size, detail: `HTML ${page.size} байт, ${page.contentType || 'тип не указан'}` });
    preview = parsePreview(page.html, target.identifier, collectedAt);
    subscribers = preview.subscribers;
    posts = preview.posts;
    stages.push({ stage: 'parse', status: 'ok', detail: `Публикаций: ${posts.length}; подписчики: ${subscribers.available ? 'есть' : 'нет'}` });
  } catch (error) {
    previewError = toDiagnosticError(error);
    stages.push({ stage: 'preview', status: 'error', code: previewError.code, detail: previewError.message, ...previewError.details });
  }
  const token = options.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    try {
      const botCount = await fetchMemberCount(target.identifier, { ...options, token });
      if (subscribers?.available && subscribers.value !== botCount.value) {
        stages.push({ stage: 'bot', status: 'ok', detail: `Bot API: ${botCount.value}; предпросмотр: ${subscribers.value}` });
      } else {
        stages.push({ stage: 'bot', status: 'ok', detail: `getChatMemberCount=${botCount.value}` });
      }
      subscribers = botCount;
    } catch (error) {
      const normalized = toDiagnosticError(error);
      stages.push({ stage: 'bot', status: 'error', code: normalized.code, detail: normalized.message });
    }
  } else {
    stages.push({ stage: 'bot', status: 'missing', code: 'AUTH_MISSING', detail: 'TELEGRAM_BOT_TOKEN не задан; проверен только публичный предпросмотр.' });
  }
  const name = preview?.name || null;
  return {
    community: { name, url: target.communityUrl, subscribers: subscribers || {
      available: false, value: null, raw: null, approximate: false, source: null, collectedAt,
      reason: previewError ? previewError.message : 'Подписчики недоступны.',
    } },
    posts,
    stages,
    collectedAt,
    previewError,
  };
}

module.exports = { fetchPreview, parsePreview, parseCompactNumber, fetchMemberCount, collectCommunity, redact, decodeHtml };
