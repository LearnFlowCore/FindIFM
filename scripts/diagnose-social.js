// Диагностика сбора статистики VK и Telegram.
// Локальный режим: проверка парсеров на фикстурах без сети.
// Живой режим: фактические запросы к переданным сообществам.
const fs = require('node:fs');
const path = require('node:path');
const { runDiagnostics, redactDeep } = require('../src/social/diagnostics');
const { parseTargetSpec } = require('../src/social/identify');
const { SocialStore } = require('../src/social/store');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const withStore = !args.includes('--no-store');
const specs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--target') specs.push(args[++index]);
  else if (arg.startsWith('--target=')) specs.push(arg.slice('--target='.length));
}
if (process.env.SOCIAL_TARGETS) specs.push(...process.env.SOCIAL_TARGETS.split(/[\n,]+/));

const targets = [];
const invalidTargets = [];
const seen = new Set();
for (const spec of specs.map(item => String(item || '').trim()).filter(Boolean)) {
  try {
    const target = parseTargetSpec(spec);
    const key = `${target.platform}:${target.identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  } catch (error) {
    invalidTargets.push({ spec, code: error.code || 'UNKNOWN', message: error.message });
  }
}

const reportDir = path.resolve(process.env.SOCIAL_DIAGNOSTICS_DIR || path.join(root, 'diagnostics'));
fs.mkdirSync(reportDir, { recursive: true });
const store = live && withStore ? new SocialStore(path.join(reportDir, 'social.sqlite')) : null;

function stamp(value) { return String(value).replace(/[:.]/g, '-'); }
function metricLine(label, metric) {
  if (!metric) return `- ${label}: нет данных`;
  if (metric.available) return `- ${label}: ${metric.value}${metric.approximate ? ' (приблизительно)' : ''} · источник ${metric.source}${metric.raw ? ` · исходное «${metric.raw}»` : ''}`;
  return `- ${label}: недоступно · ${metric.reason || 'причина неизвестна'}`;
}
function markdown(report) {
  const lines = [`# Диагностика соцсетей · ${report.runAt}`, '', `Режим: **${report.mode}**. Статус: **${report.status}**.`, ''];
  if (report.mode === 'local') {
    lines.push('## Самопроверки парсеров', '', '| Проверка | Результат | Детали |', '| --- | --- | --- |');
    for (const check of report.checks) lines.push(`| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} | ${String(check.detail).replace(/\|/g, '\\|')} |`);
  } else {
    lines.push('## Сводка', '', `- Источников: ${report.summary.sources}`);
    lines.push(`- Успешно: ${report.summary.success} · частично: ${report.summary.partial} · неуспешно: ${report.summary.failed}`);
    lines.push(`- Подписчики получены: ${report.summary.subscribersAvailable} · недоступны: ${report.summary.subscribersUnavailable}`);
    lines.push(`- Публикаций проверено: ${report.summary.postsChecked} · с просмотрами: ${report.summary.postsWithViews}`);
    lines.push(`- Последний успешный сбор: ${report.summary.lastSuccessAt || 'нет'}`);
    const frequency = Object.entries(report.summary.errorFrequency || {});
    lines.push(`- Ошибки: ${frequency.length ? frequency.map(([code, count]) => `${code}×${count}`).join(', ') : 'нет'}`);
    if (report.instructions?.length) lines.push('', '## Инструкция', '', ...report.instructions.map(item => `- ${item}`));
    if (report.invalidTargets?.length) {
      lines.push('', '## Некорректные цели', '');
      for (const item of report.invalidTargets) lines.push(`- ${item.spec}: ${item.code} — ${item.message}`);
    }
    for (const result of report.results) {
      lines.push('', `## ${result.platform} · ${result.communityUrl}`, '');
      lines.push(`Статус: **${result.status}** · длительность ${result.durationMs} мс · HTTP ${result.httpStatus ?? '—'}`);
      if (result.communityName) lines.push(`Название: ${result.communityName}`);
      lines.push('', metricLine('Подписчики', result.metrics.subscribers), metricLine('Просмотры', result.metrics.views));
      lines.push('', `Публикаций проверено: ${result.postsChecked} · с просмотрами: ${result.postsWithViews}`);
      for (const post of result.posts) {
        const views = post.views?.available ? `${post.views.value}${post.views.approximate ? ' ≈' : ''}${post.views.raw ? ` («${post.views.raw}»)` : ''}` : 'нет';
        lines.push(`- ${post.url || post.externalId}: ${post.publishedAt || 'дата неизвестна'}, просмотры: ${views}`);
      }
      for (const error of result.errors) lines.push(`- Ошибка ${error.code} (${error.stage}): ${error.message}`);
      for (const warning of result.warnings) lines.push(`- Предупреждение: ${warning}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
function print(report) {
  console.log(`Статус: ${report.status} · режим: ${report.mode} · ${report.runAt}`);
  if (report.mode === 'local') {
    for (const check of report.checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    console.log(`Самопроверки: ${report.summary.passed}/${report.summary.checks}`);
    return;
  }
  if (report.instructions?.length) {
    console.log('NO_TARGETS_CONFIGURED');
    for (const line of report.instructions) console.log(`  ${line}`);
  }
  if (report.invalidTargets?.length) for (const item of report.invalidTargets) console.log(`Некорректная цель ${item.spec}: ${item.code} — ${item.message}`);
  for (const result of report.results) {
    console.log(`\n[${result.platform.toUpperCase()}] ${result.communityUrl} — ${result.status} · ${result.durationMs} мс · HTTP ${result.httpStatus ?? '—'}`);
    if (result.finalUrl && result.finalUrl !== result.communityUrl) console.log(`  итоговый URL: ${result.finalUrl}`);
    if (result.communityName) console.log(`  название: ${result.communityName}`);
    console.log(`  ${metricLine('подписчики', result.metrics.subscribers).slice(2)}`);
    console.log(`  ${metricLine('просмотры', result.metrics.views).slice(2)}`);
    console.log(`  публикаций: ${result.postsChecked}, с просмотрами: ${result.postsWithViews}`);
    for (const error of result.errors) console.log(`  ошибка ${error.code} (${error.stage}): ${error.message}`);
    for (const warning of result.warnings) console.log(`  предупреждение: ${warning}`);
  }
  console.log(`\nИтог: источников ${report.summary.sources}, успешно ${report.summary.success}, частично ${report.summary.partial}, неуспешно ${report.summary.failed}`);
  console.log(`Подписчики: доступны ${report.summary.subscribersAvailable}, недоступны ${report.summary.subscribersUnavailable}`);
  console.log(`Публикации: проверено ${report.summary.postsChecked}, с просмотрами ${report.summary.postsWithViews}`);
  console.log(`Последний успешный сбор: ${report.summary.lastSuccessAt || 'нет'}`);
  const frequency = Object.entries(report.summary.errorFrequency || {});
  console.log(`Ошибки: ${frequency.length ? frequency.map(([code, count]) => `${code}×${count}`).join(', ') : 'нет'}`);
}

(async () => {
  let report;
  try {
    report = await runDiagnostics({ mode: live ? 'live' : 'local', targets, options: { store } });
  } catch (error) {
    console.error(`Диагностика не выполнена: ${error.message}`);
    if (store) store.close();
    process.exitCode = 1;
    return;
  }
  if (invalidTargets.length) report.invalidTargets = invalidTargets;
  const secrets = [process.env.VK_ACCESS_TOKEN, process.env.TELEGRAM_BOT_TOKEN].filter(Boolean);
  report = redactDeep(report, secrets);
  const base = path.join(reportDir, `social-${stamp(report.runAt)}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(`${base}.md`, markdown(report), 'utf8');
  if (store) store.close();
  print(report);
  console.log(`\nОтчёт: ${base}.json и ${base}.md`);
  if (report.status === 'NO_TARGETS_CONFIGURED') process.exitCode = 2;
  else if (report.mode === 'local') process.exitCode = report.status === 'ok' ? 0 : 1;
  else process.exitCode = report.summary.success + report.summary.partial > 0 ? 0 : 1;
})();
