// Все SQL-операции собраны в одном репозитории и выполняются параметризованно.
const DEFAULT_SETTINGS = {
  browserPath: '',
  profileType: 'temporary', profilePath: '', userAgent: 'Автоматический User-Agent браузера',
  pageDelay: 500, pageJitter: 150, resultDelay: 250, resultJitter: 100,
  maxPages: 5, maxResults: 500, maxDurationMinutes: 30, captchaStrategy: process.env.CAPTCHA_STRATEGY || 'stop', notifications: true,
  notifyOnFinish: true, notifyOnError: true, notifyOnNewData: true,
  telegramEnabled: false, telegramBotToken: '', telegramChatId: '',
  emailEnabled: false, emailHost: '', emailPort: 587, emailSecure: false,
  emailUser: '', emailPassword: '', emailFrom: '', emailTo: '',
  exportFolder: 'exports', showUnknownDate: true,
};

class Repository {
  constructor(db) { this.db = db; }
  addHistory(jobId, query) {
    this.db.prepare(`INSERT INTO search_history
      (job_id,query,query_json,extracted_date,period,date_from,date_to,whitelist,blacklist,timestamp,status)
      VALUES (?,?,?,?,?,?,?,?,?,datetime('now','localtime'),'queued')`)
      .run(jobId, query.original, JSON.stringify(query), query.extractedDate, query.period, query.from, query.to,
        JSON.stringify(query.whitelist), JSON.stringify(query.blacklist));
  }
  finishHistory(jobId, status, resultsCount = 0, duplicatesCount = 0, error = null) {
    this.db.prepare("UPDATE search_history SET status=?,results_count=?,duplicates_count=?,error=?,progress=100,finished_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE job_id=?")
      .run(status, resultsCount, duplicatesCount, error, jobId);
  }
  updateTask(jobId, status, progress, message = null) {
    this.db.prepare("UPDATE search_history SET status=?,progress=?,message=?,started_at=CASE WHEN ?='running' AND started_at IS NULL THEN datetime('now','localtime') ELSE started_at END,updated_at=datetime('now','localtime') WHERE job_id=?").run(status, progress, message, status, jobId);
  }
  addTaskLog(jobId, level, event, message, context = null) {
    this.db.prepare('INSERT INTO task_logs(job_id,level,event,message,context_json) VALUES(?,?,?,?,?)').run(jobId, level, event, message, context ? JSON.stringify(context) : null);
  }
  taskLogs(jobId, limit = 200) { return this.db.prepare('SELECT * FROM task_logs WHERE job_id=? ORDER BY id DESC LIMIT ?').all(jobId, Math.min(500, Math.max(1, Number(limit) || 200))).reverse(); }
  tasks({ status } = {}) { return status ? this.db.prepare('SELECT * FROM search_history WHERE status=? ORDER BY id DESC LIMIT 200').all(status) : this.db.prepare('SELECT * FROM search_history ORDER BY id DESC LIMIT 200').all(); }
  hasUrl(url) { return Boolean(this.db.prepare('SELECT 1 FROM results WHERE url_normalized=? LIMIT 1').get(url)); }
  addResults(jobId, rows) {
    const statement = this.db.prepare(`INSERT INTO results
      (job_id,url,url_normalized,domain,title,date,description,query,search_date,search_run_date,status,snippet_match,category,text_length,has_media,evidence,semantic_score)
      VALUES (@jobId,@url,@urlNormalized,@domain,@title,@date,@description,@query,@searchDate,@searchRunDate,@status,@snippetMatch,@category,@textLength,@hasMedia,@evidence,@semanticScore)`);
    this.db.transaction(items => items.forEach(item => statement.run({ jobId, ...item, category: item.category || '', textLength: Number(item.textLength || 0), hasMedia: Number(item.hasMedia || 0), evidence: item.evidence || '', semanticScore: item.semanticScore ?? null })))(rows);
  }
  results(options = {}) {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
    const sort = ['search_date', 'date', 'domain', 'title', 'status', 'query'].includes(options.sort) ? options.sort : 'search_date';
    const order = String(options.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const where = [], args = [];
    if (options.jobId) { where.push('job_id=?'); args.push(options.jobId); }
    if (options.includeUnknownDate === false || options.undefinedDate === false) where.push("date IS NOT NULL AND date<>''");
    if (options.status) { where.push('status=?'); args.push(options.status); }
    if (options.domain) {
      const exact = String(options.domain).startsWith('=');
      const domain = String(options.domain).replace(/^=/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      if (exact) { where.push('domain=?'); args.push(domain); }
      else { where.push('(domain=? OR domain LIKE ?)'); args.push(domain, `%.${domain}`); }
    }
    if (options.dateFrom) { where.push('date IS NOT NULL AND date>=?'); args.push(options.dateFrom); }
    if (options.dateTo) { where.push('date IS NOT NULL AND date<=?'); args.push(options.dateTo); }
    if (options.category) { where.push('category LIKE ?'); args.push(`%${options.category}%`); }
    if (options.minTextLength) { where.push('text_length>=?'); args.push(Number(options.minTextLength)); }
    if (options.maxTextLength) { where.push('text_length<=?'); args.push(Number(options.maxTextLength)); }
    if (options.hasMedia === true) where.push('has_media=1');
    if (options.hasMedia === false) where.push('has_media=0');
    for (const word of String(options.includeKeywords || '').split(',').map(x => x.trim()).filter(Boolean)) { where.push('(title LIKE ? OR description LIKE ?)'); args.push(`%${word}%`, `%${word}%`); }
    for (const word of String(options.excludeKeywords || '').split(',').map(x => x.trim()).filter(Boolean)) { where.push('(title NOT LIKE ? AND description NOT LIKE ?)'); args.push(`%${word}%`, `%${word}%`); }
    if (options.q) { where.push('(title LIKE ? OR url LIKE ? OR domain LIKE ? OR description LIKE ? OR query LIKE ?)'); args.push(...Array(5).fill(`%${options.q}%`)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM results ${clause}`).get(...args).count;
    const groups = this.db.prepare(`SELECT query,COUNT(*) AS count,COUNT(DISTINCT domain) AS domains FROM results ${clause} GROUP BY query ORDER BY query`)
      .all(...args);
    const rankOrder = options.jobId && sort === 'search_date' && order === 'DESC' ? 'semantic_score DESC,' : '';
    const rows = this.db.prepare(`SELECT * FROM results ${clause} ORDER BY ${rankOrder}${sort} ${order},id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, (page - 1) * limit);
    const summary = this.db.prepare(`SELECT COUNT(*) AS publications, COUNT(DISTINCT domain) AS media,
      MIN(date) AS date_from, MAX(date) AS date_to FROM results ${clause}`).get(...args);
    return { rows, groups, summary, total, page, limit };
  }
  allResults(jobId) { return this.db.prepare(`SELECT * FROM results ${jobId ? 'WHERE job_id=?' : ''} ORDER BY id DESC`).all(...(jobId ? [jobId] : [])); }
  reportResults({ scope, jobId, from, to }) {
    const where = [], args = [];
    if (scope === 'current') { where.push('job_id=?'); args.push(jobId); }
    if (from) { where.push("date IS NOT NULL AND date<>'' AND date>=?"); args.push(from); }
    if (to) { where.push("date IS NOT NULL AND date<>'' AND date<=?"); args.push(to); }
    return this.db.prepare(`SELECT * FROM results ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC,id DESC`).all(...args);
  }
  resultDynamics({ jobId, from, to }) {
    const where = ["date IS NOT NULL", "date GLOB '????-??-??'"], args = [];
    if (jobId) { where.push('job_id=?'); args.push(jobId); }
    if (from) { where.push('date>=?'); args.push(from); }
    if (to) { where.push('date<=?'); args.push(to); }
    const points = this.db.prepare(`SELECT date AS day, COUNT(*) AS count FROM results WHERE ${where.join(' AND ')} GROUP BY date ORDER BY date`).all(...args);
    return { points, total: points.reduce((sum, point) => sum + point.count, 0) };
  }
  resultsByQueryDate(jobId) {
    const history = this.db.prepare('SELECT * FROM search_history WHERE job_id=?').get(jobId);
    if (!history?.extracted_date) throw new Error('В текущем поисковом запросе не указана дата.');
    const rows = this.db.prepare(`SELECT * FROM results
      WHERE job_id=? AND date IS NOT NULL AND date<>'' AND date>=? AND date<=?
      ORDER BY date DESC, id DESC`).all(jobId, history.date_from, history.date_to);
    return { rows, query: history.query, extractedDate: history.extracted_date, from: history.date_from, to: history.date_to };
  }
  history() { return this.db.prepare('SELECT * FROM search_history ORDER BY id DESC').all(); }
  historyById(value) { return this.db.prepare('SELECT * FROM search_history WHERE id=? OR job_id=?').get(value, value); }
  updateAnalytics(jobId, values) {
    const columns = { spikeAt: 'spike_at', notifiedAt: 'notified_at', responseAt: 'response_at' };
    const entries = Object.entries(values).filter(([key]) => columns[key]);
    if (!entries.length) return this.historyById(jobId);
    this.db.prepare(`UPDATE search_history SET ${entries.map(([key]) => `${columns[key]}=?`).join(',')},updated_at=datetime('now','localtime') WHERE job_id=?`)
      .run(...entries.map(([, value]) => value), jobId);
    return this.historyById(jobId);
  }
  analyticsSummary(jobId) {
    return this.db.prepare('SELECT COUNT(*) AS publications, COUNT(DISTINCT domain) AS sources FROM results WHERE job_id=?').get(jobId);
  }
  presets() { return this.db.prepare('SELECT * FROM domain_presets ORDER BY name').all(); }
  savePreset(preset, oldName = null) {
    const domains = Array.isArray(preset.domains) ? preset.domains : [...(preset.whitelist || []), ...(preset.blacklist || [])];
    const type = preset.type || (preset.blacklist?.length ? 'blacklist' : 'whitelist');
    if (oldName && oldName !== preset.name) this.deletePreset(oldName);
    this.db.prepare(`INSERT INTO domain_presets(name,type,domains) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET type=excluded.type,domains=excluded.domains`)
      .run(preset.name, type, JSON.stringify(domains));
    return this.db.prepare('SELECT * FROM domain_presets WHERE name=?').get(preset.name);
  }
  deletePreset(name) { this.db.prepare('DELETE FROM domain_presets WHERE name=?').run(name); }
  settings() {
    const saved = {};
    for (const item of this.db.prepare('SELECT key,value FROM settings').all()) {
      try { saved[item.key] = JSON.parse(item.value); } catch { this.db.prepare('DELETE FROM settings WHERE key=?').run(item.key); }
    }
    return { ...DEFAULT_SETTINGS, ...saved };
  }
  setSettings(values) {
    const statement = this.db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    this.db.transaction(entries => entries.forEach(([key, value]) => statement.run(key, JSON.stringify(value))))(Object.entries(values));
  }
  deleteResult(id) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT id,job_id FROM results WHERE id=?').get(id);
      if (!row) return false;
      this.db.prepare('DELETE FROM results WHERE id=?').run(row.id);
      this.db.prepare('UPDATE search_history SET results_count=(SELECT COUNT(*) FROM results WHERE job_id=?) WHERE job_id=?')
        .run(row.job_id, row.job_id);
      return true;
    })();
  }
  clearResults() { this.db.prepare('DELETE FROM results').run(); }
  clearHistory() { this.db.transaction(() => { this.db.prepare('DELETE FROM results').run(); this.db.prepare('DELETE FROM search_history').run(); })(); }
  interruptRunning() { this.db.prepare("UPDATE search_history SET status='interrupted',error='Приложение было закрыто' WHERE status IN ('running','waiting_captcha','stopping','queued')").run(); }
}
module.exports = { Repository, DEFAULT_SETTINGS };
