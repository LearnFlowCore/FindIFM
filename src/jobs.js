// Асинхронные задания связывают запрос, провайдер, базу и уведомления.
const crypto = require('node:crypto');
const { parseQuery } = require('./utils/query');

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
    this.jobs.set(id, { id, status: 'queued', progress: 0, query, results: [], resultsCount: 0, duplicatesCount: 0, captcha: false, error: null });
    this.repo.addHistory(id, query);
    this.queue = this.queue.then(() => this.run(id, query));
    return id;
  }
  async run(id, query) {
    const job = this.jobs.get(id);
    this.running = true;
    try {
      job.status = 'running'; job.progress = 5;
      const online = await this.internetCheck();
      if (!online.ok) {
        this.notify('Поиск остановлен: нет интернет-соединения');
        throw new Error('Нет интернет-соединения');
      }
      const settings = this.repo.settings();
      const { candidates, withinDuplicates } = await this.provider.search(query, settings, {
        onCaptcha: () => {
          job.captcha = true; job.message = 'Яндекс запросил капчу — пройдите её в окне браузера';
          this.notify(job.message);
        },
      });
      job.progress = 85;
      const rows = [], now = new Date().toISOString(), historical = new Set();
      let duplicates = withinDuplicates; job.duplicatesCount = duplicates;
      for (const item of candidates) {
        const duplicate = this.repo.hasUrl(item.normalized) || historical.has(item.normalized);
        historical.add(item.normalized);
        if (duplicate) { duplicates += 1; job.duplicatesCount = duplicates; }
        if (duplicate && query.deduplicate) continue;
        const status = duplicate ? 'уже найден ранее' : item.snippetMatch ? 'совпадение по сниппету' : item.date ? 'новый' : 'дата не определена';
        rows.push({
          url: item.url, urlNormalized: item.normalized, domain: new URL(item.normalized).hostname.replace(/^www\./, ''),
          title: item.title || item.url, date: item.date || null, description: String(item.description || item.snippet || '').slice(0, 300),
          query: query.original, searchDate: now, searchRunDate: now, status, snippetMatch: item.snippetMatch ? 1 : 0,
        });
      }
      this.repo.addResults(id, rows);
      Object.assign(job, { status: 'completed', progress: 100, captcha: false, results, resultsCount: rows.length, duplicatesCount: duplicates });
      this.repo.finishHistory(id, 'completed', rows.length, duplicates);
      this.notify(`Парсинг завершён: ${rows.length} результатов найдено, ${duplicates} дубликатов отброшено. Запрос: ${query.original}`);
    } catch (error) {
      this.log.error({ error: error.stack || error.message, jobId: id }, 'Ошибка поискового задания');
      Object.assign(job, { status: 'failed', error: error.message || 'Неизвестная ошибка поискового задания', progress: 100 });
      this.repo.finishHistory(id, 'failed', job.resultsCount, job.duplicatesCount, error.message);
    } finally {
      this.running = false;
      if (this.jobs.size > 100) {
        const finished = [...this.jobs].filter(([, item]) => !['queued', 'running'].includes(item.status));
        for (const [oldId] of finished.slice(0, this.jobs.size - 100)) this.jobs.delete(oldId);
      }
    }
  }
  get(id) { return this.jobs.get(id) || null; }
  isBusy() { return this.running || [...this.jobs.values()].some(job => job.status === 'queued'); }
  stopAccepting() { this.accepting = false; }
  async waitForIdle() { await this.queue; }
}
module.exports = { JobManager };
