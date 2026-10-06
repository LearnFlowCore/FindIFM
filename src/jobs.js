// Асинхронные задания связывают запрос, провайдер, базу и уведомления.
const crypto = require('node:crypto');
const { parseQuery } = require('./utils/query');
const { exportTxtSnapshot } = require('./export');
const { cleanText, normalizePrices, titleKey, sourceId, validHttpUrl } = require('./utils/content');
const semantic = require('./semantic');

class JobManager {
  constructor(repo, provider, logger, notify, internetCheck) {
    this.repo = repo; this.provider = provider; this.log = logger;
    this.notify = notify; this.internetCheck = internetCheck; this.jobs = new Map();
    this.queue = Promise.resolve(); this.accepting = true; this.running = false; this.captchaTokens = new Map();
  }
  start(input) {
    if (!this.accepting) throw new Error('Приложение завершает работу и не принимает новые задания.');
    const query = parseQuery(input);
    const id = crypto.randomUUID();
    this.captchaTokens.set(id, crypto.randomBytes(32).toString('hex'));
    this.jobs.set(id, { id, status: 'queued', progress: 0, query, results: [], liveResults: [], resultsCount: 0, duplicatesCount: 0, captcha: false, error: null, checkedPages: 0, liveMatches: 0, skippedErrors: 0, recentChecks: [], startedAt: null, deadlineAt: null });
    this.repo.addHistory(id, query);
    this.repo.addTaskLog(id, 'info', 'queued', 'Задача поставлена в очередь');
    this.queue = this.queue.then(() => this.run(id, query));
    return id;
  }
  async run(id, query) {
    const job = this.jobs.get(id);
    if (job.cancelled) { this.captchaTokens.delete(id); return; }
    this.running = true;
    try {
       job.status = 'running'; job.progress = 5; job.startedAt = Date.now();
      this.repo.updateTask(id, 'running', 5, 'Проверка соединения');
      this.repo.addTaskLog(id, 'info', 'started', 'Задача запущена');
      const online = await this.internetCheck();
      if (!online.ok) {
        this.notify('failed', 'Поиск остановлен: нет интернет-соединения');
        throw new Error('Нет интернет-соединения');
      }
       const settings = this.repo.settings();
       if (process.platform === 'linux') settings.captchaStrategy = 'manual';
       if (query.quickTest) { settings.maxPages = 1; settings.maxResults = 5; settings.maxDurationMinutes = Math.min(settings.maxDurationMinutes, 5); query.deepPages = 0; }
       job.deadlineAt = Date.now() + Math.max(1, Number(settings.maxDurationMinutes) || 30) * 60000;
       settings.deadlineAt = job.deadlineAt;
       const { candidates, withinDuplicates } = await this.provider.search(query, settings, {
        isCancelled: () => Boolean(job.cancelled),
        onCaptcha: () => {
          job.captcha = true; job.status = 'waiting_captcha'; job.message = settings.captchaStrategy === 'skip'
            ? 'Яндекс запросил CAPTCHA: поиск будет остановлен.'
            : settings.captchaStrategy === 'manual' ? 'Яндекс запросил CAPTCHA: пройдите проверку ниже на странице результатов (до 15 минут).'
            : 'Капча/блокировка: пройдите проверку в окне Яндекс Браузера';
          this.repo.updateTask(id, 'waiting_captcha', job.progress, job.message);
          this.repo.addTaskLog(id, 'warn', 'captcha', job.message);
          this.notify('captcha', job.message);
        },
        onCaptchaSolved: () => {
          job.status = 'running'; job.captcha = false; job.message = 'CAPTCHA подтверждена, поиск продолжается';
          this.repo.updateTask(id, 'running', job.progress, job.message);
          this.repo.addTaskLog(id, 'info', 'captcha_solved', job.message);
        },
        onSearchPage: page => { query.resumePage = page; this.repo.updateQuery(id, query); },
        onCheckpoint: (page, count) => {
          const progress = Math.min(80, 5 + Math.round((page / Math.max(1, settings.maxPages)) * 70));
          job.status = 'running'; job.progress = progress; job.searchPages = page; job.searchCards = count; job.message = `Обработано страниц: ${page}, карточек: ${count}`;
          this.repo.updateTask(id, 'running', progress, job.message);
          this.repo.addTaskLog(id, 'info', 'checkpoint', job.message, { page, count });
        },
        onSitePage: (checked, url, found, matched) => {
          job.status = 'running'; job.progress = Math.min(84, Math.max(job.progress, 80));
          job.message = `Проверено страниц сайтов: ${checked}, совпадений: ${found}`;
          job.checkedPages = checked; job.liveMatches = found; job.currentUrl = url;
          job.recentChecks.unshift({ url, matched, checked });
          job.recentChecks.length = Math.min(job.recentChecks.length, 6);
          this.repo.updateTask(id, 'running', job.progress, job.message);
          if (checked === 1 || checked % 10 === 0) this.repo.addTaskLog(id, 'info', 'site_page', job.message, { checked, url, found });
        },
        onSiteError: () => { job.skippedErrors += 1; },
        onCandidate: item => {
          if (!validHttpUrl(item.url)) return;
          job.liveMatches += 1;
          if (job.liveResults.length >= 200) return;
          job.liveResults.push({ url: item.url, domain: new URL(item.normalized).hostname.replace(/^www\./, ''),
            title: String(item.title || item.url).slice(0, 250), date: item.date || null,
            description: String(item.description || item.snippet || '').slice(0, 1200),
            category: item.category || '', text_length: Number(item.textLength || item.text?.length || 0),
            has_media: item.hasMedia ? 1 : 0, status: 'Предварительно', query: query.original });
        },
      });
       if (job.cancelled) throw new Error('Поиск остановлен пользователем');
      if (query.semantic) {
        this.repo.updateTask(id, 'running', 82, 'Оценка смысловой близости публикаций');
        candidates.splice(0, candidates.length, ...await semantic.rank(query.text, candidates, () => Boolean(job.cancelled)));
      }
      job.progress = 85;
      this.repo.updateTask(id, 'running', 85, 'Формирование результатов');
       const rows = [], now = new Date().toISOString(), historical = new Set(), titles = new Set(), sourceIds = new Set();
      let duplicates = withinDuplicates; job.duplicatesCount = duplicates;
       for (const item of candidates) {
         if (job.cancelled) throw new Error('Поиск остановлен пользователем');
        if (!validHttpUrl(item.url)) { this.repo.addTaskLog(id, 'warn', 'validation', 'Пропущена некорректная ссылка', { url: item.url }); continue; }
        const normalizedTitle = titleKey(item.title);
        const itemSourceId = sourceId(item.url);
        const duplicate = this.repo.hasUrl(item.normalized) || historical.has(item.normalized);
        const contentDuplicate = (normalizedTitle && titles.has(normalizedTitle)) || (itemSourceId && sourceIds.has(itemSourceId));
        historical.add(item.normalized);
        if (normalizedTitle) titles.add(normalizedTitle);
        if (itemSourceId) sourceIds.add(itemSourceId);
        if (duplicate || contentDuplicate) { duplicates += 1; job.duplicatesCount = duplicates; }
        if ((duplicate || contentDuplicate) && query.deduplicate) continue;
        const status = duplicate || contentDuplicate ? 'уже найден ранее' : item.snippetMatch ? 'совпадение по сниппету' : item.date ? 'новый' : 'дата не определена';
        rows.push({
          url: item.url, urlNormalized: item.normalized, domain: new URL(item.normalized).hostname.replace(/^www\./, ''),
          title: cleanText(item.title || item.url), date: item.date || null, description: normalizePrices(item.description || item.snippet).slice(0, 2000),
          query: query.original, searchDate: now, searchRunDate: now, status, snippetMatch: item.snippetMatch ? 1 : 0,
          category: item.category || '', textLength: Number(item.textLength || item.text?.length || 0), hasMedia: item.hasMedia ? 1 : 0,
          evidence: item.evidence || '', semanticScore: item.semanticScore ?? null,
        });
      }
      this.repo.addResults(id, rows);
       const textFile = exportTxtSnapshot(rows, id);
       Object.assign(job, { status: 'completed', progress: 100, captcha: false, results: rows, liveResults: [], resultsCount: rows.length, duplicatesCount: duplicates, textFile });
      this.repo.finishHistory(id, 'completed', rows.length, duplicates);
      this.repo.addTaskLog(id, 'info', 'completed', `Завершено: ${rows.length} результатов`);
       this.notify(rows.length ? 'new-data' : 'completed', query.quickTest
         ? `Тест одной страницы завершён: ${rows.length} результатов. Файл сохранён: ${textFile}`
         : `Парсинг завершён: ${rows.length} результатов найдено. Файл сохранён: ${textFile}`);
    } catch (error) {
      this.log.error({ error: error.stack || error.message, jobId: id }, 'Ошибка поискового задания');
      const cancelled = job.cancelled;
       const reason = error.message || 'Неизвестная ошибка поискового задания';
       const readable = /captcha|капч|429|блокиров/i.test(reason) ? `Капча/блокировка: ${reason}`
         : /timeout|тайм-аут|timed out/i.test(reason) ? `Таймаут: ${reason}`
         : /распознать|селектор|карточки|parse/i.test(reason) ? `Не удалось распарсить страницу: ${reason}`
         : /лимит|limit/i.test(reason) ? `Превышен лимит: ${reason}` : reason;
        if (!cancelled && error.code === 'CAPTCHA_TIMEOUT') {
          Object.assign(job, { status: 'paused_captcha', error: readable, message: 'Ожидание CAPTCHA истекло. Поиск можно продолжить с этой страницы.', captcha: false });
          this.repo.updateTask(id, 'paused_captcha', job.progress, job.message);
          this.repo.addTaskLog(id, 'warn', 'captcha_paused', job.message, { resumePage: query.resumePage || 0 });
          return;
        }
        Object.assign(job, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : readable, progress: 100 });
      this.repo.finishHistory(id, job.status, job.resultsCount, job.duplicatesCount, job.error);
       job.message = cancelled ? 'Поиск остановлен' : readable;
       this.repo.addTaskLog(id, cancelled ? 'info' : 'error', job.status, cancelled ? 'Задача остановлена' : job.error);
      if (!cancelled) this.notify('failed', `Ошибка поиска «${query.original}»: ${job.error}`);
    } finally {
      this.captchaTokens.delete(id);
      this.running = false;
      if (this.jobs.size > 100) {
        const finished = [...this.jobs].filter(([, item]) => !['queued', 'running'].includes(item.status));
        for (const [oldId] of finished.slice(0, this.jobs.size - 100)) this.jobs.delete(oldId);
      }
    }
  }
  get(id) { const job = this.jobs.get(id); return job ? { ...job, serverNow: Date.now() } : null; }
  captchaToken(id) { return this.captchaTokens.get(id); }
  canControlCaptcha(id, token) { return this.jobs.get(id)?.status === 'waiting_captcha' && !!token && this.captchaTokens.get(id) === token; }
  list(status) { return this.repo.tasks({ status }).map(row => ({ ...row, live: this.jobs.get(row.job_id) || null })); }
  logs(id, limit) { return this.repo.taskLogs(id, limit); }
  async stop(id) {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'running', 'waiting_captcha'].includes(job.status)) return false;
    job.cancelled = true; job.status = 'stopping'; job.message = 'Остановка задачи';
    this.repo.updateTask(id, 'stopping', job.progress, job.message);
    this.repo.addTaskLog(id, 'warn', 'stopping', 'Запрошена остановка задачи');
    if (this.running && job.progress > 0) await this.provider.browser.close();
    if (job.progress === 0) { job.status = 'cancelled'; job.progress = 100; this.repo.finishHistory(id, 'cancelled'); }
    return true;
  }
  async resume(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'paused_captcha') return false;
    if (this.isBusy()) throw new Error('Дождитесь завершения другого поиска.');
    const query = JSON.parse(JSON.stringify(job.query));
    job.cancelled = false; job.status = 'queued'; job.error = null; job.message = 'Поиск поставлен в очередь для продолжения';
    this.repo.updateTask(id, 'queued', job.progress, job.message);
    this.repo.addTaskLog(id, 'info', 'resumed', `Продолжение с страницы ${Number(query.resumePage || 0) + 1}`);
    this.captchaTokens.set(id, crypto.randomBytes(32).toString('hex'));
    this.queue = this.queue.then(() => this.run(id, query));
    return true;
  }
  isBusy() { return this.running || [...this.jobs.values()].some(job => job.status === 'queued'); }
  stopAccepting() { this.accepting = false; }
  async waitForIdle() { await this.queue; }
}
module.exports = { JobManager };
