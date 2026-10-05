// Управляемый локальный сервер: импорт модуля не запускает процессы и не открывает БД.
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const pino = require('pino');
const notifier = require('node-notifier');
const { createConfig } = require('./config');
const { openDatabase } = require('./db');
const { Repository } = require('./repository');
const { YandexBrowser } = require('./browser');
const { YandexHTMLProvider } = require('./search/provider');
const { JobManager } = require('./jobs');
const { NotificationService } = require('./notifications');
const { exportXlsx, exportCsv, exportTxt } = require('./export');
const semantic = require('./semantic');

function highlightTerms(query) {
  const phrase = String(query || '').trim().replace(/^['"«]+|['"»]+$/g, '');
  const words = phrase.split(/\s+/).map(word => word.trim()).filter(word => word.length > 1);
  return [...new Set([phrase, ...words].filter(word => word.length > 1))].sort((a, b) => b.length - a.length).slice(0, 30);
}
function validPeriodDate(value) {
  return !value || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
}

function remoteUrlAllowed(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (['localhost', 'localhost.localdomain'].includes(host) || host.endsWith('.localhost') || host === '::1') return false;
  if (/^(10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  return true;
}

function highlightedHtml(html, url, query) {
  const terms = highlightTerms(query);
  const payload = JSON.stringify(terms).replace(/<\//g, '<\\/');
  const injection = `<base href="${String(url).replace(/"/g, '&quot;')}"><style>mark.signal-hit{background:#ffe66d;color:inherit;padding:0 .08em;border-radius:.16em;box-shadow:0 0 0 1px #f4c43055}</style><script>(function(){const terms=${payload};if(!terms.length)return;const pattern=new RegExp('('+terms.map(x=>x.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')).join('|')+')','giu');const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())if(!/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT)$/i.test(walker.currentNode.parentElement?.tagName||''))nodes.push(walker.currentNode);for(const node of nodes){const value=node.nodeValue;if(!pattern.test(value)){pattern.lastIndex=0;continue}pattern.lastIndex=0;const fragment=document.createDocumentFragment();let last=0;value.replace(pattern,(hit,_,offset)=>{fragment.append(document.createTextNode(value.slice(last,offset)));const mark=document.createElement('mark');mark.className='signal-hit';mark.textContent=hit;fragment.append(mark);last=offset+hit.length;return hit});fragment.append(document.createTextNode(value.slice(last)));node.replaceWith(fragment)}})()</script>`;
  if (/<body\b[^>]*>/i.test(html)) return html.replace(/<\/body>/i, () => `${injection}</body>`);
  return `${injection}${html}`;
}

async function startServer(options = {}) {
  const config = createConfig(options);
  const exportRoot = path.join(config.dataRoot, 'exports');
  for (const folder of ['data', 'logs', 'exports']) fs.mkdirSync(path.join(config.dataRoot, folder), { recursive: true });

  const logFile = pino.destination(path.join(config.dataRoot, 'logs', 'parser.log'));
  const log = pino({ level: process.env.LOG_LEVEL || 'info' }, pino.multistream([{ stream: process.stdout }, { stream: logFile }]));
  const db = openDatabase(config.dbPath);
  const repo = new Repository(db);
  repo.interruptRunning();
  const browser = new YandexBrowser(config, log, config.dataRoot);
  const provider = new YandexHTMLProvider(browser, log);
  const internet = { ok: false, detail: 'Проверка не выполнена', checkedAt: null };
  const token = options.token === undefined ? null : options.token;
  let stopping = false;

  function checkInternet() {
    return new Promise(resolve => {
      const request = require('node:https').get('https://ya.ru/', { timeout: 5000 }, response => {
        response.resume();
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 500, detail: `HTTP ${response.statusCode}` });
      });
      request.on('timeout', () => request.destroy(new Error('Тайм-аут')));
      request.on('error', error => resolve({ ok: false, detail: error.message }));
    }).then(status => {
      Object.assign(internet, status, { checkedAt: new Date().toISOString() });
      return status;
    });
  }

  const desktopNotify = message => options.notify ? options.notify(message) : notifier.notify({ title: 'Сигнал', message });
  const notifications = new NotificationService(repo, desktopNotify, log);
  const notify = (event, message) => { notifications.send(event, message).catch(error => log.warn({ error: error.message }, 'Ошибка уведомления')); };

  const jobs = new JobManager(repo, provider, log, notify, checkInternet);
  const app = express();
  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.requestLimit }));
  app.use(express.static(path.join(config.projectRoot, 'public')));
  app.get('/highlight', asyncRoute(async (req, res) => {
    const target = String(req.query.url || '');
    if (!remoteUrlAllowed(target)) return res.status(400).send('Некорректная внешняя ссылка.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(target, { signal: controller.signal, headers: { 'User-Agent': 'Signal/1.0 page preview' } });
      if (!response.ok) return res.status(502).send(`Сайт вернул HTTP ${response.status}.`);
      const type = response.headers.get('content-type') || '';
      if (!type.includes('text/html')) return res.redirect(target);
      const html = (await response.text()).slice(0, 4_000_000);
      res.set('Content-Type', 'text/html; charset=utf-8').send(highlightedHtml(html.replace(/<meta\s+[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, ''), target, req.query.q));
    } finally { clearTimeout(timer); }
  }));
  app.use('/api', (req, res, next) => {
    if (!token || req.get('X-App-Token') === token) return next();
    return res.status(401).json({ error: 'Недействительная сессия приложения.' });
  });
  app.use('/exports', (req, res, next) => {
    if (!token || req.query.token === token) return next();
    return res.status(401).send('Недействительная сессия приложения.');
  }, express.static(exportRoot, { index: false, dotfiles: 'deny' }));

  const requireBody = (req, res, next) => req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? next() : res.status(400).json({ error: 'Ожидается JSON-объект.' });
  const rejectWhileBusy = (_req, res, next) => jobs.isBusy()
    ? res.status(409).json({ error: 'Дождитесь завершения текущего поиска.' }) : next();

  app.get('/api/status', asyncRoute(async (_req, res) => {
    const status = await checkInternet();
    const settings = repo.settings();
    const browserPath = settings.browserPath || config.browserExecutable;
    res.json({
      ok: true, internet: status.ok, detail: status.detail, checkedAt: internet.checkedAt,
      browserPath, browserExists: Boolean(browserPath && fs.existsSync(browserPath)),
      browserConnected: Boolean(browser.browser?.connected), semanticAvailable: semantic.configured(),
    });
  }));
  app.post('/api/search', requireBody, asyncRoute(async (req, res) => {
    if (req.body.semantic === true && !semantic.configured()) return res.status(503).json({ error: 'Поиск по смыслу пока не настроен: нужен AI_API_KEY на сервере.' });
    const status = await checkInternet();
    if (!status.ok) { notify('failed', 'Поиск остановлен: нет интернет-соединения'); return res.status(503).json({ error: 'Нет интернет-соединения.' }); }
    const jobId = jobs.start(req.body);
    return res.status(202).json({ jobId, captchaToken: jobs.captchaToken(jobId) });
  }));
  app.post('/api/search/test', requireBody, rejectWhileBusy, asyncRoute(async (req, res) => {
    if (req.body.semantic === true && !semantic.configured()) return res.status(503).json({ error: 'Поиск по смыслу пока не настроен: нужен AI_API_KEY на сервере.' });
    const status = await checkInternet();
    if (!status.ok) return res.status(503).json({ error: 'Нет интернет-соединения.' });
    const jobId = jobs.start({ ...req.body, quickTest: true });
    return res.status(202).json({ jobId, captchaToken: jobs.captchaToken(jobId) });
  }));
  const jobStatus = (req, res) => {
    const job = jobs.get(req.params.id);
    return job ? res.json(job) : res.status(404).json({ error: 'Задание не найдено.' });
  };
  app.get('/api/search/:id', jobStatus);
  app.get('/api/jobs/:id', jobStatus);
  app.get('/api/jobs', (req, res) => res.json(jobs.list(req.query.status)));
  app.get('/api/jobs/:id/logs', (req, res) => res.json(jobs.logs(req.params.id, req.query.limit)));
  const requireCaptchaAccess = (req, res, next) => jobs.canControlCaptcha(req.params.id, req.get('X-Captcha-Token'))
    ? next() : res.status(403).json({ error: 'Нет доступа к активной CAPTCHA этой задачи.' });
  app.get('/api/jobs/:id/captcha', requireCaptchaAccess, asyncRoute(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await browser.captchaScreenshot());
  }));
  app.post('/api/jobs/:id/captcha', requireBody, requireCaptchaAccess, asyncRoute(async (req, res) => {
    await browser.captchaAction(req.body);
    res.json({ ok: true });
  }));
  app.post('/api/jobs/:id/stop', asyncRoute(async (req, res) => await jobs.stop(req.params.id)
    ? res.json({ ok: true }) : res.status(409).json({ error: 'Задачу нельзя остановить.' })));
  app.post('/api/jobs/:id/restart', asyncRoute(async (req, res) => {
    const previous = repo.historyById(req.params.id);
    if (!previous) return res.status(404).json({ error: 'Задание не найдено.' });
    const query = JSON.parse(previous.query_json);
    if (query.semantic && !semantic.configured()) return res.status(503).json({ error: 'Для повтора поиска по смыслу нужен AI_API_KEY на сервере.' });
    const jobId = jobs.start(query);
    return res.status(202).json({ jobId, captchaToken: jobs.captchaToken(jobId) });
  }));
  app.get('/api/results', (req, res) => res.json(repo.results({
    jobId: req.query.jobId, page: req.query.page, limit: req.query.limit || req.query.pageSize,
    sort: req.query.sort, order: req.query.order, q: req.query.q, status: req.query.status,
    domain: req.query.domain, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo, category: req.query.category,
    minTextLength: req.query.minTextLength, maxTextLength: req.query.maxTextLength,
    hasMedia: req.query.hasMedia === 'present' ? true : req.query.hasMedia === 'absent' ? false : undefined,
    includeKeywords: req.query.includeKeywords, excludeKeywords: req.query.excludeKeywords,
    includeUnknownDate: req.query.includeUnknownDate !== 'false' && req.query.undefinedDate !== 'false',
  })));
  app.get('/api/results/dynamics', (req, res) => {
    const { jobId, from, to } = req.query;
    if (!validPeriodDate(from) || !validPeriodDate(to) || (from && to && from > to)) return res.status(400).json({ error: 'Укажите корректный период.' });
    const run = jobId ? repo.historyById(jobId) : null;
    if (jobId && !run) return res.status(404).json({ error: 'Поисковый запуск не найден.' });
    return res.json(repo.resultDynamics({ jobId: run?.job_id, from, to }));
  });
  app.post('/api/semantic/summary', requireBody, asyncRoute(async (req, res) => {
    if (!semantic.configured()) return res.status(503).json({ error: 'Языковая модель пока не настроена: нужен AI_API_KEY на сервере.' });
    const run = req.body.jobId ? repo.historyById(req.body.jobId) : null;
    if (req.body.jobId && !run && !Array.isArray(req.body.rows)) return res.status(404).json({ error: 'Поисковый запуск не найден.' });
    if (!run && !Array.isArray(req.body.rows)) return res.status(400).json({ error: 'Выберите поиск или сохранённый архив.' });
    const rows = run ? repo.allResults(run.job_id).sort((a, b) => (b.semantic_score ?? -1) - (a.semantic_score ?? -1)) : req.body.rows;
    const selected = rows.slice(0, 12).filter(row => row && typeof row === 'object' && remoteUrlAllowed(row.url)).map(row => ({
      url: row.url, title: String(row.title || '').slice(0, 250), date: String(row.date || '').slice(0, 32),
      evidence: String(row.evidence || row.description || '').slice(0, 700),
    }));
    const question = String(req.body.question || run?.query || '').trim().slice(0, 500);
    if (!question) return res.status(400).json({ error: 'Укажите вопрос для сводки.' });
    return res.json(await semantic.summarize(question, selected));
  }));
  app.delete('/api/results/:id', rejectWhileBusy, (req, res) => repo.deleteResult(req.params.id)
    ? res.status(204).end() : res.status(404).json({ error: 'Результат не найден.' }));
  app.get('/api/history', (_req, res) => res.json(repo.history()));
  app.get('/api/analytics/:id', (req, res) => {
    const run = repo.historyById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Поисковый запуск не найден.' });
    const { metrics } = require('./analytics');
    return res.json({ jobId: run.job_id, query: run.query, status: run.status, resultsCount: run.results_count,
      sourcesCount: repo.analyticsSummary(run.job_id).sources,
      spikeAt: run.spike_at, notifiedAt: run.notified_at, responseAt: run.response_at, ...metrics({ spikeAt: run.spike_at, notifiedAt: run.notified_at, responseAt: run.response_at }) });
  });
  app.put('/api/analytics/:id', requireBody, (req, res) => {
    const run = repo.historyById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Поисковый запуск не найден.' });
    const { parseEventTimes, metrics } = require('./analytics');
    const changes = parseEventTimes(req.body);
    if (!Object.keys(changes).length) return res.status(400).json({ error: 'Укажите время всплеска, уведомления или реакции.' });
    const merged = { spikeAt: run.spike_at, notifiedAt: run.notified_at, responseAt: run.response_at, ...changes };
    if (merged.spikeAt && merged.notifiedAt && Date.parse(merged.notifiedAt) < Date.parse(merged.spikeAt)) return res.status(400).json({ error: 'Уведомление не может предшествовать всплеску.' });
    if (merged.notifiedAt && merged.responseAt && Date.parse(merged.responseAt) < Date.parse(merged.notifiedAt)) return res.status(400).json({ error: 'Реакция не может предшествовать уведомлению.' });
    repo.updateAnalytics(run.job_id, changes);
    return res.json({ jobId: run.job_id, query: run.query, status: run.status, resultsCount: run.results_count,
      sourcesCount: repo.analyticsSummary(run.job_id).sources,
      ...merged, ...metrics(merged) });
  });
  app.post('/api/history/:id/rerun', asyncRoute(async (req, res) => {
    const previous = repo.historyById(req.params.id);
    if (!previous) return res.status(404).json({ error: 'Запись истории не найдена.' });
    let query;
    try { query = JSON.parse(previous.query_json); } catch { return res.status(409).json({ error: 'Параметры этого запуска повреждены.' }); }
    if (query.semantic && !semantic.configured()) return res.status(503).json({ error: 'Для повтора поиска по смыслу нужен AI_API_KEY на сервере.' });
    const status = await checkInternet();
    if (!status.ok) return res.status(503).json({ error: 'Нет интернет-соединения.' });
    const jobId = jobs.start(query);
    return res.status(202).json({ jobId, captchaToken: jobs.captchaToken(jobId) });
  }));
  app.delete('/api/history', rejectWhileBusy, (_req, res) => { repo.clearHistory(); res.status(204).end(); });
  app.delete('/api/results', rejectWhileBusy, (_req, res) => { repo.clearResults(); res.status(204).end(); });
  app.get('/api/presets', (_req, res) => res.json(repo.presets()));
  app.post('/api/presets', requireBody, (req, res) => req.body.name
    ? res.status(201).json(repo.savePreset(req.body)) : res.status(400).json({ error: 'Укажите название.' }));
  app.put('/api/presets/:name', requireBody, (req, res) => res.json(repo.savePreset({ ...req.body, name: req.body.name || req.params.name }, req.params.name)));
  app.delete('/api/presets/:name', (req, res) => { repo.deletePreset(req.params.name); res.status(204).end(); });
  app.get('/api/settings', (_req, res) => {
    const settings = repo.settings();
    res.json({ ...settings, telegramBotToken: '', emailPassword: '', telegramTokenConfigured: Boolean(settings.telegramBotToken), emailPasswordConfigured: Boolean(settings.emailPassword) });
  });
  app.put('/api/settings', requireBody, (req, res) => {
    const allowed = ['browserPath', 'profileType', 'profilePath', 'pageDelay', 'pageJitter', 'resultDelay', 'resultJitter', 'maxPages', 'maxResults', 'maxDurationMinutes', 'captchaStrategy', 'notifications', 'showUnknownDate', 'notifyOnFinish', 'notifyOnError', 'notifyOnNewData', 'telegramEnabled', 'telegramBotToken', 'telegramChatId', 'emailEnabled', 'emailHost', 'emailPort', 'emailSecure', 'emailUser', 'emailPassword', 'emailFrom', 'emailTo'];
    const values = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));
    if (!values.telegramBotToken) delete values.telegramBotToken;
    if (!values.emailPassword) delete values.emailPassword;
    for (const key of ['pageDelay', 'pageJitter', 'resultDelay', 'resultJitter']) {
      if (key in values && (!Number.isFinite(values[key]) || values[key] < 0 || values[key] > 300000)) return res.status(400).json({ error: `Некорректное значение ${key}` });
    }
    if ('maxPages' in values && (!Number.isInteger(values.maxPages) || values.maxPages < 1 || values.maxPages > 100)) return res.status(400).json({ error: 'Количество страниц должно быть от 1 до 100.' });
    if ('maxResults' in values && (!Number.isInteger(values.maxResults) || values.maxResults < 1 || values.maxResults > 5000)) return res.status(400).json({ error: 'Лимит результатов должен быть от 1 до 5000.' });
    if ('maxDurationMinutes' in values && (!Number.isInteger(values.maxDurationMinutes) || values.maxDurationMinutes < 1 || values.maxDurationMinutes > 240)) return res.status(400).json({ error: 'Лимит времени должен быть от 1 до 240 минут.' });
    if (values.browserPath && (path.basename(values.browserPath).toLowerCase() !== 'browser.exe' || !fs.existsSync(values.browserPath))) return res.status(400).json({ error: 'Укажите существующий browser.exe Яндекс Браузера.' });
    if (values.profileType && !['temporary', 'user'].includes(values.profileType)) return res.status(400).json({ error: 'Некорректный профиль.' });
    if (values.captchaStrategy && !['stop', 'skip', 'manual'].includes(values.captchaStrategy)) return res.status(400).json({ error: 'Некорректная стратегия капчи.' });
    repo.setSettings(values);
    return res.json(repo.settings());
  });

  async function makeExport(scope, jobId) {
    if (scope === 'current' && !jobId) throw Object.assign(new Error('Не выбран текущий запуск.'), { statusCode: 400 });
    const rows = repo.allResults(scope === 'current' ? jobId : null);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const filename = `results_${stamp}.xlsx`;
    const file = path.join(exportRoot, filename);
    await exportXlsx(rows, file);
     notify('completed', `Файл сохранён: ${file}`);
    return { file: filename, url: `/exports/${encodeURIComponent(filename)}${token ? `?token=${encodeURIComponent(token)}` : ''}` };
  }
  app.post('/api/export', requireBody, asyncRoute(async (req, res) => res.json(await makeExport(req.body.scope || 'current', req.body.jobId))));
  app.post('/api/export/report', requireBody, asyncRoute(async (req, res) => {
    const { scope, format, jobId, from, to } = req.body;
    if (!['current', 'all'].includes(scope) || !['xlsx', 'csv', 'txt'].includes(format)) return res.status(400).json({ error: 'Выберите тип и формат отчёта.' });
    const run = scope === 'current' && jobId ? repo.historyById(jobId) : null;
    if (scope === 'current' && !run) return res.status(400).json({ error: 'Выберите существующий поисковый запуск.' });
    if (!validPeriodDate(from) || !validPeriodDate(to) || (from && to && from > to)) return res.status(400).json({ error: 'Проверьте даты начала и конца периода.' });
    const rows = repo.reportResults({ scope, jobId: run?.job_id, from, to });
    const file = `report_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(4).toString('hex')}.${format}`;
    const destination = path.join(exportRoot, file);
    if (format === 'xlsx') await exportXlsx(rows, destination);
    else if (format === 'csv') exportCsv(rows, destination);
    else exportTxt(rows, destination);
    return res.json({ file, count: rows.length, url: `/exports/${encodeURIComponent(file)}${token ? `?token=${encodeURIComponent(token)}` : ''}` });
  }));
  app.post('/api/export/txt', requireBody, asyncRoute(async (req, res) => {
    const rows = repo.allResults(req.body.jobId || null);
    const filename = 'FindIFM.txt';
    const file = path.join(exportRoot, filename);
    exportTxt(rows, file);
    notify('completed', `TXT сохранён: ${rows.length} ссылок`);
    return res.json({ file: filename, count: rows.length,
      url: `/exports/${encodeURIComponent(filename)}${token ? `?token=${encodeURIComponent(token)}` : ''}` });
  }));
  app.post('/api/export/by-query-date', requireBody, asyncRoute(async (req, res) => {
    if (!req.body.jobId) throw Object.assign(new Error('Не выбран текущий запуск.'), { statusCode: 400 });
    const selection = repo.resultsByQueryDate(req.body.jobId);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const base = `results_query-date_${stamp}`;
    const xlsx = `${base}.xlsx`; const csv = `${base}.csv`;
    await exportXlsx(selection.rows, path.join(exportRoot, xlsx));
    exportCsv(selection.rows, path.join(exportRoot, csv));
    notify('completed', `Выгрузка по дате запроса сохранена: ${selection.rows.length} ссылок`);
    const link = file => `/exports/${encodeURIComponent(file)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    return res.json({ query: selection.query, extractedDate: selection.extractedDate, from: selection.from, to: selection.to,
      rows: selection.rows, count: selection.rows.length, xlsx: { file: xlsx, url: link(xlsx) }, csv: { file: csv, url: link(csv) } });
  }));
  app.get('/api/export', asyncRoute(async (req, res) => {
    const result = await makeExport(req.query.jobId ? 'current' : 'all', req.query.jobId);
    res.redirect(result.url);
  }));
  app.use((error, _req, res, _next) => {
    log.error({ error: error.stack || error.message }, 'Ошибка API');
    if (error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'API получил некорректный JSON.' });
    }
    return res.status(error.statusCode || 500).json({ error: error.message || 'Внутренняя ошибка.' });
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://${config.host}:${actualPort}`;
  log.info({ url }, 'Сервер запущен');
  if (options.openBrowser) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  const internetTimer = setInterval(checkInternet, 10000);
  internetTimer.unref();
  checkInternet();

  async function stop() {
    if (stopping) return;
    stopping = true;
    jobs.stopAccepting();
    clearInterval(internetTimer);
    const serverClosed = new Promise(resolve => server.close(resolve));
    await jobs.waitForIdle();
    try { await browser.close(); } catch (error) { log.warn({ error: error.message }, 'Ошибка закрытия браузера'); }
    await serverClosed;
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    logFile.flushSync?.();
    logFile.end?.();
  }

  return { app, server, url, token, checkInternet, stop, config };
}

if (require.main === module) {
  let service;
  startServer({ openBrowser: process.env.OPEN_BROWSER !== '0' }).then(started => { service = started; }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
  const shutdown = () => service ? service.stop().finally(() => process.exit(0)) : process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startServer, highlightedHtml };
