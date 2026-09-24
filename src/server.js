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
const { exportXlsx } = require('./export');

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

  function notify(message) {
    if (repo.settings().notifications === false) return;
    if (options.notify) options.notify(message);
    else notifier.notify({ title: 'Монитор упоминаний', message });
  }

  const jobs = new JobManager(repo, provider, log, notify, checkInternet);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.requestLimit }));
  app.use(express.static(path.join(config.projectRoot, 'public')));
  app.use('/api', (req, res, next) => {
    if (!token || req.get('X-App-Token') === token) return next();
    return res.status(401).json({ error: 'Недействительная сессия приложения.' });
  });
  app.use('/exports', (req, res, next) => {
    if (!token || req.query.token === token) return next();
    return res.status(401).send('Недействительная сессия приложения.');
  }, express.static(exportRoot, { index: false, dotfiles: 'deny' }));

  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
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
      browserConnected: Boolean(browser.browser?.connected),
    });
  }));
  app.post('/api/search', requireBody, asyncRoute(async (req, res) => {
    const status = await checkInternet();
    if (!status.ok) { notify('Поиск остановлен: нет интернет-соединения'); return res.status(503).json({ error: 'Нет интернет-соединения.' }); }
    return res.status(202).json({ jobId: jobs.start(req.body) });
  }));
  const jobStatus = (req, res) => {
    const job = jobs.get(req.params.id);
    return job ? res.json(job) : res.status(404).json({ error: 'Задание не найдено.' });
  };
  app.get('/api/search/:id', jobStatus);
  app.get('/api/jobs/:id', jobStatus);
  app.get('/api/results', (req, res) => res.json(repo.results({
    jobId: req.query.jobId, page: req.query.page, limit: req.query.limit || req.query.pageSize,
    sort: req.query.sort, order: req.query.order, q: req.query.q, status: req.query.status,
    includeUnknownDate: req.query.includeUnknownDate !== 'false' && req.query.undefinedDate !== 'false',
  })));
  app.delete('/api/results/:id', rejectWhileBusy, (req, res) => repo.deleteResult(req.params.id)
    ? res.status(204).end() : res.status(404).json({ error: 'Результат не найден.' }));
  app.get('/api/history', (_req, res) => res.json(repo.history()));
  app.post('/api/history/:id/rerun', asyncRoute(async (req, res) => {
    const previous = repo.historyById(req.params.id);
    if (!previous) return res.status(404).json({ error: 'Запись истории не найдена.' });
    let query;
    try { query = JSON.parse(previous.query_json); } catch { return res.status(409).json({ error: 'Параметры этого запуска повреждены.' }); }
    const status = await checkInternet();
    if (!status.ok) return res.status(503).json({ error: 'Нет интернет-соединения.' });
    return res.status(202).json({ jobId: jobs.start(query) });
  }));
  app.delete('/api/history', rejectWhileBusy, (_req, res) => { repo.clearHistory(); res.status(204).end(); });
  app.delete('/api/results', rejectWhileBusy, (_req, res) => { repo.clearResults(); res.status(204).end(); });
  app.get('/api/presets', (_req, res) => res.json(repo.presets()));
  app.post('/api/presets', requireBody, (req, res) => req.body.name
    ? res.status(201).json(repo.savePreset(req.body)) : res.status(400).json({ error: 'Укажите название.' }));
  app.put('/api/presets/:name', requireBody, (req, res) => res.json(repo.savePreset({ ...req.body, name: req.body.name || req.params.name }, req.params.name)));
  app.delete('/api/presets/:name', (req, res) => { repo.deletePreset(req.params.name); res.status(204).end(); });
  app.get('/api/settings', (_req, res) => res.json(repo.settings()));
  app.put('/api/settings', requireBody, (req, res) => {
    const allowed = ['browserPath', 'profileType', 'profilePath', 'pageDelay', 'pageJitter', 'resultDelay', 'resultJitter', 'maxPages', 'captchaStrategy', 'notifications', 'showUnknownDate'];
    const values = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));
    for (const key of ['pageDelay', 'pageJitter', 'resultDelay', 'resultJitter']) {
      if (key in values && (!Number.isFinite(values[key]) || values[key] < 0 || values[key] > 300000)) return res.status(400).json({ error: `Некорректное значение ${key}` });
    }
    if ('maxPages' in values && (!Number.isInteger(values.maxPages) || values.maxPages < 1 || values.maxPages > 100)) return res.status(400).json({ error: 'Количество страниц должно быть от 1 до 100.' });
    if (values.browserPath && (path.basename(values.browserPath).toLowerCase() !== 'browser.exe' || !fs.existsSync(values.browserPath))) return res.status(400).json({ error: 'Укажите существующий browser.exe Яндекс Браузера.' });
    if (values.profileType && !['temporary', 'user'].includes(values.profileType)) return res.status(400).json({ error: 'Некорректный профиль.' });
    if (values.captchaStrategy && !['stop', 'skip'].includes(values.captchaStrategy)) return res.status(400).json({ error: 'Некорректная стратегия капчи.' });
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
    notify(`Файл сохранён: ${file}`);
    return { file: filename, url: `/exports/${encodeURIComponent(filename)}${token ? `?token=${encodeURIComponent(token)}` : ''}` };
  }
  app.post('/api/export', requireBody, asyncRoute(async (req, res) => res.json(await makeExport(req.body.scope || 'current', req.body.jobId))));
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

module.exports = { startServer };
