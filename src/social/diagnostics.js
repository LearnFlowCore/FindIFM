// Оркестрация диагностики: классификация, статусы, сохранение и отчёт.
const { DiagnosticError, toDiagnosticError } = require('./errors');
const identify = require('./identify');
const vk = require('./vk');
const telegram = require('./telegram');

const unavailable = (reason, source = null) => ({
  available: false, value: null, raw: null, approximate: false, source, collectedAt: null, reason,
});

function viewsMetric(posts, collectedAt) {
  const withViews = posts.filter(post => post.views?.available);
  const first = withViews[0]?.views;
  return {
    available: withViews.length > 0,
    value: null,
    postsChecked: posts.length,
    postsWithViews: withViews.length,
    source: first?.source || null,
    collectedAt: first?.collectedAt || collectedAt || null,
    reason: withViews.length
      ? 'Просмотры доступны только по отдельным публикациям; сумма по разным периодам не вычисляется.'
      : posts.length ? 'Ни у одной публикации нет счётчика просмотров.' : 'Публикации не получены.',
  };
}

function statusOf(result) {
  const subscribers = result.metrics.subscribers.available;
  const posts = result.postsChecked;
  const views = result.postsWithViews;
  if (subscribers && posts > 0 && views === posts) return 'success';
  if (subscribers || views > 0) return 'partial';
  return 'failed';
}

function httpInfo(stages) {
  const withStatus = stages.find(stage => Number.isFinite(stage.httpStatus));
  const withUrl = [...stages].reverse().find(stage => stage.finalUrl);
  return { httpStatus: withStatus?.httpStatus ?? null, finalUrl: withUrl?.finalUrl ?? null };
}

async function diagnoseTarget(target, options = {}) {
  const started = Date.now();
  const result = {
    platform: target.platform,
    communityUrl: target.communityUrl,
    communityName: null,
    status: 'failed',
    durationMs: 0,
    httpStatus: null,
    finalUrl: null,
    stages: [{ stage: 'identify', status: 'ok', detail: `Идентификатор: ${target.identifier}` }],
    metrics: { subscribers: unavailable('Проверка не выполнена.'), views: viewsMetric([], null) },
    posts: [],
    postsChecked: 0,
    postsWithViews: 0,
    errors: [],
    warnings: [],
    collectedAt: null,
  };
  try {
    if (target.platform === 'vk') {
      if (!(options.token ?? process.env.VK_ACCESS_TOKEN)) {
        result.stages.push({ stage: 'auth', status: 'missing', code: 'AUTH_MISSING', detail: 'VK_ACCESS_TOKEN не задан.' });
      }
      try {
        const data = await vk.collectCommunity(target, options);
        result.communityName = data.community.name;
        result.metrics.subscribers = data.community.subscribers;
        result.posts = data.posts;
        result.stages.push(...data.stages.filter(stage => stage.stage !== 'auth' || stage.status !== 'ok'));
        if (!data.community.subscribers.available) result.warnings.push(data.community.subscribers.reason);
      } catch (error) {
        const normalized = toDiagnosticError(error);
        const partial = normalized.partial || {};
        if (partial.community) {
          result.communityName = partial.community.name;
          result.metrics.subscribers = partial.community.subscribers;
        }
        result.stages.push(...(partial.stages || []));
        if (!partial.community) result.metrics.subscribers = unavailable(normalized.message);
        result.errors.push({ stage: 'vk', code: normalized.code, message: normalized.message, details: normalized.details || null });
      }
    } else {
      const data = await telegram.collectCommunity(target, { ...options, telegramToken: options.telegramToken });
      result.communityName = data.community.name;
      result.metrics.subscribers = data.community.subscribers;
      result.posts = data.posts;
      result.stages.push(...data.stages.filter(stage => stage.stage !== 'bot' || stage.status !== 'missing'));
      if (data.previewError) result.errors.push({ stage: 'preview', code: data.previewError.code, message: data.previewError.message, details: data.previewError.details || null });
      if (!data.community.subscribers.available && data.community.subscribers.reason && !data.previewError) result.warnings.push(data.community.subscribers.reason);
      if (data.stages.some(stage => stage.stage === 'bot' && stage.status === 'missing')) {
        result.warnings.push('TELEGRAM_BOT_TOKEN не задан: количество подписчиков проверено только по публичному предпросмотру.');
      }
    }
  } catch (error) {
    const normalized = error instanceof DiagnosticError ? error : toDiagnosticError(error);
    result.errors.push({ stage: 'unknown', code: normalized.code, message: normalized.message, details: normalized.details || null });
  }

  result.postsChecked = result.posts.length;
  result.postsWithViews = result.posts.filter(post => post.views?.available).length;
  result.collectedAt = result.metrics.subscribers.collectedAt || result.posts.find(post => post.views?.collectedAt)?.views.collectedAt || null;
  result.metrics.views = viewsMetric(result.posts, result.collectedAt);
  const info = httpInfo(result.stages);
  result.httpStatus = info.httpStatus;
  result.finalUrl = info.finalUrl;
  result.status = statusOf(result);

  if (options.store) {
    try {
      result.persistence = {
        community: options.store.saveCommunity({
          platform: target.platform, identifier: target.identifier, url: result.communityUrl,
          name: result.communityName, subscribers: result.metrics.subscribers,
        }),
        posts: options.store.savePosts(target.platform, target.identifier, result.posts),
      };
    } catch (error) {
      result.errors.push({ stage: 'persistence', code: 'PERSISTENCE_ERROR', message: error.message, details: null });
      if (result.status === 'success') result.status = 'partial';
    }
  }
  result.durationMs = Date.now() - started;
  return result;
}

function summarize(results) {
  const errorFrequency = {};
  for (const result of results) for (const error of result.errors) errorFrequency[error.code] = (errorFrequency[error.code] || 0) + 1;
  const successes = results.filter(result => result.status === 'success');
  return {
    sources: results.length,
    success: successes.length,
    partial: results.filter(result => result.status === 'partial').length,
    failed: results.filter(result => result.status === 'failed').length,
    subscribersAvailable: results.filter(result => result.metrics.subscribers.available).length,
    subscribersUnavailable: results.filter(result => !result.metrics.subscribers.available).length,
    postsChecked: results.reduce((sum, result) => sum + result.postsChecked, 0),
    postsWithViews: results.reduce((sum, result) => sum + result.postsWithViews, 0),
    errorFrequency,
    lastSuccessAt: successes.map(result => result.collectedAt).filter(Boolean).sort().pop() || null,
  };
}

async function runDiagnostics({ mode = 'local', targets = [], options = {} } = {}) {
  const runAt = new Date().toISOString();
  if (mode === 'local') {
    const { runSelfChecks } = require('./selfcheck');
    const checks = runSelfChecks();
    return {
      runAt, mode: 'local',
      status: checks.every(check => check.passed) ? 'ok' : 'failed',
      summary: { checks: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, targets: targets.length },
      checks, results: [],
    };
  }
  if (!targets.length) {
    return {
      runAt, mode: 'live', status: 'NO_TARGETS_CONFIGURED',
      summary: { sources: 0, success: 0, partial: 0, failed: 0, subscribersAvailable: 0, subscribersUnavailable: 0, postsChecked: 0, postsWithViews: 0, errorFrequency: {}, lastSuccessAt: null },
      results: [],
      instructions: [
        'Реальные цели не заданы. Передайте публичные сообщества, например:',
        'node scripts/diagnose-social.js --live --target vk=https://vk.com/community --target telegram=https://t.me/channel',
        'или задайте переменную SOCIAL_TARGETS="vk=https://…,telegram=https://…".',
        'Не используйте вымышленные адреса: диагностика проверяет именно переданные сообщества.',
      ],
    };
  }
  const results = [];
  for (const target of targets) results.push(await diagnoseTarget(target, options));
  const summary = summarize(results);
  return { runAt, mode: 'live', status: results.some(result => result.status !== 'failed') ? 'completed' : 'failed', summary, results };
}

// Убирает секреты из отчёта перед записью.
function redactDeep(value, secrets = []) {
  const list = secrets.filter(secret => typeof secret === 'string' && secret.length >= 8);
  if (!list.length) return value;
  if (typeof value === 'string') return list.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, list));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, list)]));
  return value;
}

module.exports = { runDiagnostics, diagnoseTarget, summarize, viewsMetric, statusOf, redactDeep, identify };
