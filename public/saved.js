// Архив поисков хранится в браузере: он переживает перезапуск бесплатного Render.
(function (root) {
  'use strict';
  const databaseName = 'signal-saved-searches';
  let connection;

  function open() {
    if (!root.indexedDB) return Promise.reject(new Error('Браузер не поддерживает хранение результатов. Скачайте CSV.'));
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('searches', { keyPath: 'jobId' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Не удалось открыть хранилище браузера.'));
    }).catch(error => { connection = null; throw error; });
    return connection;
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('searches', mode);
      const request = action(tx.objectStore('searches'));
      let value;
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(new Error('Не удалось сохранить результаты в браузере. Проверьте свободное место.'));
      tx.onabort = () => reject(new Error('Сохранение результатов было прервано.'));
    });
  }
  function normalizeRow(row) {
    return {
      url: row.url || '', title: row.title || '', domain: row.domain || '', date: row.date || '',
      description: row.description || '', query: row.query || '', status: row.status || '',
      category: row.category || '', text_length: Number(row.text_length ?? row.textLength ?? 0),
      has_media: Number(row.has_media ?? row.hasMedia ?? 0),
    };
  }
  const put = record => transaction('readwrite', store => store.put({
    jobId: record.jobId, query: record.query, savedAt: record.savedAt || new Date().toISOString(),
    rows: record.rows.map(normalizeRow),
  }));
  const list = async () => (await transaction('readonly', store => store.getAll()))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const remove = id => transaction('readwrite', store => store.delete(id));
  function csv(record) {
    const cell = value => {
      let text = String(value ?? '');
      if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const columns = ['query', 'url', 'title', 'domain', 'date', 'description', 'status', 'category'];
    return ['Ключевой запрос,URL,Заголовок,Сайт,Дата,Описание,Статус,Категория',
      ...record.rows.map(row => columns.map(column => cell(column === 'query' ? row.query || record.query : row[column])).join(','))].join('\r\n');
  }
  const api = { put, list, remove, normalizeRow, csv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SignalSaved = api;
}(typeof window === 'undefined' ? globalThis : window));
