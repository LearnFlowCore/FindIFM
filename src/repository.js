// Все SQL-операции собраны в одном репозитории и выполняются параметризованно.
const DEFAULT_SETTINGS = {
  browserPath: '',
  profileType: 'temporary', profilePath: '', userAgent: 'Автоматический User-Agent браузера',
  pageDelay: 2000, pageJitter: 500, resultDelay: 1000, resultJitter: 300,
  maxPages: 5, captchaStrategy: 'stop', notifications: true,
  exportFolder: 'exports', showUnknownDate: true,
};

class Repository {
  constructor(db) { this.db = db; }
  addHistory(jobId, query) {
    this.db.prepare(`INSERT INTO search_history
      (job_id,query,query_json,extracted_date,period,date_from,date_to,whitelist,blacklist,timestamp,status)
      VALUES (?,?,?,?,?,?,?,?,?,datetime('now','localtime'),'running')`)
      .run(jobId, query.original, JSON.stringify(query), query.extractedDate, query.period, query.from, query.to,
        JSON.stringify(query.whitelist), JSON.stringify(query.blacklist));
  }
  finishHistory(jobId, status, resultsCount = 0, duplicatesCount = 0, error = null) {
    this.db.prepare('UPDATE search_history SET status=?,results_count=?,duplicates_count=?,error=? WHERE job_id=?')
      .run(status, resultsCount, duplicatesCount, error, jobId);
  }
  hasUrl(url) { return Boolean(this.db.prepare('SELECT 1 FROM results WHERE url_normalized=? LIMIT 1').get(url)); }
  addResults(jobId, rows) {
    const statement = this.db.prepare(`INSERT INTO results
      (job_id,url,url_normalized,domain,title,date,description,query,search_date,search_run_date,status,snippet_match)
      VALUES (@jobId,@url,@urlNormalized,@domain,@title,@date,@description,@query,@searchDate,@searchRunDate,@status,@snippetMatch)`);
    this.db.transaction(items => items.forEach(item => statement.run({ jobId, ...item })))(rows);
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
    if (options.q) { where.push('(title LIKE ? OR url LIKE ? OR domain LIKE ? OR description LIKE ? OR query LIKE ?)'); args.push(...Array(5).fill(`%${options.q}%`)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM results ${clause}`).get(...args).count;
    const groups = this.db.prepare(`SELECT query,COUNT(*) AS count,COUNT(DISTINCT domain) AS domains FROM results ${clause} GROUP BY query ORDER BY query`)
      .all(...args);
    const rows = this.db.prepare(`SELECT * FROM results ${clause} ORDER BY ${sort} ${order},id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, (page - 1) * limit);
    const summary = this.db.prepare(`SELECT COUNT(*) AS publications, COUNT(DISTINCT domain) AS media,
      MIN(date) AS date_from, MAX(date) AS date_to FROM results ${clause}`).get(...args);
    return { rows, groups, summary, total, page, limit };
  }
  allResults(jobId) { return this.db.prepare(`SELECT * FROM results ${jobId ? 'WHERE job_id=?' : ''} ORDER BY id DESC`).all(...(jobId ? [jobId] : [])); }
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
  interruptRunning() { this.db.prepare("UPDATE search_history SET status='interrupted',error='Приложение было закрыто' WHERE status='running'").run(); }
}
module.exports = { Repository, DEFAULT_SETTINGS };
