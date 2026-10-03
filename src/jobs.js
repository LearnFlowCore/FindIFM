// Асинхронные задания связывают запрос, провайдер, базу и уведомления.
const crypto = require('node:crypto');
const { parseQuery } = require('./utils/query');
const { exportTxtSnapshot } = require('./export');
const { cleanText, normalizePrices, titleKey, sourceId, validHttpUrl } = require('./utils/content');

class JobManager {
  constructor(repo, provider, logger, notify, internetCheck) {
    this.repo = repo; this.provider = provider; this.log = logger;
    this.notify = notify; this.internetCheck = internetCheck; this.jobs = new Map();
    this.queue = Promise.resolve(); this.accepting = true; this.running = false;
  }
  start(input) {
    if (!this.accepting) throw new Error('Приложение завершает работу и не принимает новые задания.');
    const query = parseQuery(input);
    const id = crypto.randomUUID();
    this.jobs.set(id, { id, status: 'queued', progress: 0, query, results: [], resultsCount: 0, duplicatesCount: 0, captcha: false, error: null, checkedPages: 0, liveMatches: 0, skippedErrors: 0, recentChecks: [], startedAt: null });
    this.repo.addHistory(id, query);
    this.repo.addTaskLog(id, 'info', 'queued', 'Задача поставлена в очередь');
    this.queue = this.queue.then(() => this.run(id, query));
    return id;
  }
  async run(id, query) {
    const job = this.jobs.get(id);
    if (job.cancelled) return;
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
       if (query.quickTest) { settings.maxPages = 1; settings.maxResults = 5; settings.maxDurationMinutes = Math.min(settings.maxDurationMinutes, 5); query.deepPages = 0; }
      const { candidates, withinDuplicates } = await this.provider.search(query, settings, {
        isCancelled: () => Boolean(job.cancelled),
        onCaptcha: () => {
          job.captcha = true; job.status = 'waiting_captcha'; job.message = 'Капча/блокировка: пройдите проверку в окне Яндекс Браузера';
          this.repo.updateTask(id, 'waiting_captcha', job.progress, job.message);
          this.repo.addTaskLog(id, 'warn', 'captcha', job.message);
          this.notify('captcha', job.message);
        },
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
      });
       if (job.cancelled) throw new Error('Поиск остановлен пользователем');
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
        });
      }
      this.repo.addResults(id, rows);
       const textFile = exportTxtSnapshot(rows, id);
      Object.assign(job, { status: 'completed', progress: 100, captcha: false, results: rows, resultsCount: rows.length, duplicatesCount: duplicates, textFile });
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
       Object.assign(job, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : readable, progress: 100 });
      this.repo.finishHistory(id, job.status, job.resultsCount, job.duplicatesCount, job.error);
      this.repo.addTaskLog(id, cancelled ? 'info' : 'error', job.status, cancelled ? 'Задача остановлена' : job.error);
      if (!cancelled) this.notify('failed', `Ошибка поиска «${query.original}»: ${job.error}`);
    } finally {
      this.running = false;
      if (this.jobs.size > 100) {
        const finished = [...this.jobs].filter(([, item]) => !['queued', 'running'].includes(item.status));
        for (const [oldId] of finished.slice(0, this.jobs.size - 100)) this.jobs.delete(oldId);
      }
    }
  }
  get(id) { return this.jobs.get(id) || null; }
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
  isBusy() { return this.running || [...this.jobs.values()].some(job => job.status === 'queued'); }
  stopAccepting() { this.accepting = false; }
  async waitForIdle() { await this.queue; }
}
module.exports = { JobManager };
