// Диагностика CAPTCHA: запускает тестовый поиск, показывает ответы сервера,
// забирает изображение проверки и сохраняет его в файл.
// Запуск: node scripts/captcha-debug.js
// Переменные: BASE_URL, QUERY, APP_TOKEN, KEEP=1 (не останавливать задачу).
const fs = require('node:fs');
const path = require('node:path');

const base = (process.env.BASE_URL || 'https://findifm.onrender.com').replace(/\/+$/, '');
const query = process.env.QUERY || 'Министерство образования ЛНР';
let appToken = process.env.APP_TOKEN || '';

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);

async function resolveAppToken() {
  if (appToken) return appToken;
  try {
    const response = await fetch(`${base}/app-token.js`);
    if (!response.ok) return '';
    appToken = (await response.text()).match(/"([a-f0-9]{64})"/)?.[1] || '';
  } catch { /* старый стенд без токена */ }
  return appToken;
}

async function api(route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { ...(appToken ? { 'X-App-Token': appToken } : {}), ...(options.headers || {}) },
  });
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data.slice(0, 200) : data?.error || '';
    throw new Error(`${route} → HTTP ${response.status} ${detail}`.trim());
  }
  return data;
}

async function readCaptcha(id) {
  const access = await api(`/api/jobs/${encodeURIComponent(id)}/captcha/access`);
  log('access:', `token ${String(access.captchaToken).slice(0, 8)}…`);
  const shot = await api(`/api/jobs/${encodeURIComponent(id)}/captcha`, {
    headers: { 'X-Captcha-Token': access.captchaToken },
  });
  const file = path.join(process.cwd(), `captcha-${String(id).slice(0, 8)}.jpg`);
  fs.writeFileSync(file, Buffer.from(String(shot.image || '').replace(/^data:image\/jpeg;base64,/, ''), 'base64'));
  log('captcha:', `${shot.width}x${shot.height}`, 'cookieConsent:', shot.cookieConsent ? shot.cookieConsent.label : 'нет', 'file:', file);
  return { access, shot, file };
}

(async () => {
  await resolveAppToken();
  if (appToken) log('app token:', `${appToken.slice(0, 8)}…`);
  log('base:', base);

  const status0 = await fetch(`${base}/api/status`).then(response => response.status).catch(() => 0);
  log('/api/status:', status0);

  const job = await api('/api/search/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, maxResults: 5, deepPages: 0 }),
  });
  const id = job.jobId;
  log('job:', id, 'captchaToken:', job.captchaToken ? `${String(job.captchaToken).slice(0, 8)}…` : 'нет');

  let jobStatus = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    jobStatus = await api(`/api/jobs/${encodeURIComponent(id)}`);
    log('job status:', jobStatus.status, `${jobStatus.progress}%`, jobStatus.message || '', jobStatus.error ? `error: ${jobStatus.error}` : '');
    if (['completed', 'failed', 'cancelled', 'paused_captcha', 'interrupted'].includes(jobStatus.status)) break;
    if (jobStatus.status === 'waiting_captcha') {
      try { await readCaptcha(id); } catch (error) { log('captcha error:', error.message); }
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  try {
    const logs = await api(`/api/jobs/${encodeURIComponent(id)}/logs?limit=12`);
    log('server logs:');
    for (const row of logs) console.log(`  ${row.timestamp} ${row.level}/${row.event}: ${row.message}`);
  } catch (error) { log('logs error:', error.message); }

  if (process.env.KEEP !== '1' && ['waiting_captcha', 'running', 'queued'].includes(jobStatus?.status)) {
    try { await api(`/api/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST' }); log('задача остановлена (KEEP=1 чтобы оставить)'); }
    catch (error) { log('stop error:', error.message); }
  }
})().catch(error => { console.error('Ошибка:', error.message); process.exitCode = 1; });
