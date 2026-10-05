(function (root) {
  'use strict';
  // Даты публикаций, а не даты сохранения или время поискового запуска.
  function summarize(rows, from, to) {
    const counts = new Map();
    for (const row of rows) {
      const day = row.date;
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || (from && day < from) || (to && day > to)) continue;
      counts.set(day, (counts.get(day) || 0) + 1);
    }
    const points = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));
    return { points, total: points.reduce((sum, point) => sum + point.count, 0) };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { summarize }; return; }
  const overlay = document.createElement('div');
  overlay.className = 'dynamics-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<section class="dynamics-dialog" role="dialog" aria-modal="true" aria-labelledby="dynamicsTitle">
    <header><div><span class="workflow-kicker">ДИНАМИКА ПУБЛИКАЦИЙ</span><h2 id="dynamicsTitle">Найденные ссылки по датам</h2><p id="dynamicsQuery"></p></div><button class="dynamics-close" type="button" aria-label="Закрыть">×</button></header>
    <div class="dynamics-filter"><label>С даты<input id="dynamicsFrom" type="date"></label><label>По дату<input id="dynamicsTo" type="date"></label><button type="button" id="dynamicsReset" class="button secondary">Весь период</button></div>
    <div class="dynamics-total"><strong id="dynamicsCount">0</strong><span>ссылок за выбранный период</span></div><p id="dynamicsState" role="status"></p>
    <div id="dynamicsBars" class="dynamics-bars" role="img" aria-label="Количество найденных ссылок по датам публикации"></div>
    <small>Используются даты публикаций. Ссылки без даты не входят в график.</small>
  </section>`;
  document.body.append(overlay);
  const $ = selector => overlay.querySelector(selector);
  let current = null;
  let requestId = 0;
  let selectedJobId = null;
  root.addEventListener('signal-job-selected', event => { selectedJobId = event.detail.jobId; });
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function close() { overlay.hidden = true; ++requestId; }
  $('.dynamics-close').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) close(); });
  function render({ points, total }) {
    $('#dynamicsCount').textContent = total;
    $('#dynamicsState').textContent = points.length ? `${points.length} дат с публикациями` : 'За выбранный период ссылок с датой публикации нет.';
    const maximum = Math.max(1, ...points.map(point => point.count));
    $('#dynamicsBars').innerHTML = points.map(point => `<div class="dynamics-bar"><time datetime="${escape(point.day)}">${escape(point.day.split('-').reverse().join('.'))}</time><div class="dynamics-track"><span style="width:${Math.max(2, Math.round(point.count / maximum * 100))}%"></span></div><strong>${point.count}</strong></div>`).join('');
  }
  async function update() {
    if (!current || overlay.hidden) return;
    const from = $('#dynamicsFrom').value, to = $('#dynamicsTo').value;
    if (from && to && from > to) { $('#dynamicsState').textContent = 'Дата начала позже даты окончания.'; $('#dynamicsCount').textContent = '—'; $('#dynamicsBars').replaceChildren(); return; }
    const id = ++requestId;
    if (current.rows) { render(summarize(current.rows, from, to)); return; }
    $('#dynamicsState').textContent = 'Подсчитываем ссылки…';
    try {
      const params = new URLSearchParams();
      if (current.jobId) params.set('jobId', current.jobId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const response = await fetch(`/api/results/dynamics?${params}`, { headers: root.signalAppToken ? { 'X-App-Token': root.signalAppToken } : {} });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось получить динамику.');
      if (id === requestId && !overlay.hidden) render(result);
    } catch (error) { if (id === requestId && !overlay.hidden) $('#dynamicsState').textContent = error.message; }
  }
  $('#dynamicsFrom').addEventListener('change', update);
  $('#dynamicsTo').addEventListener('change', update);
  $('#dynamicsReset').addEventListener('click', () => { $('#dynamicsFrom').value = ''; $('#dynamicsTo').value = ''; update(); });
  const button = document.createElement('button');
  button.className = 'button secondary'; button.type = 'button'; button.textContent = '▥ Динамика ссылок';
  document.querySelector('#resultsView .inline-actions').prepend(button);
  button.addEventListener('click', () => root.SignalDynamics.open({ jobId: selectedJobId, title: selectedJobId ? 'Выбранный поиск' : 'Все результаты' }));
  root.SignalDynamics = { open(source) {
    current = source;
    $('#dynamicsQuery').textContent = source.title || '';
    $('#dynamicsFrom').value = '';
    $('#dynamicsTo').value = '';
    overlay.hidden = false;
    update();
  }, summarize };
} (typeof window === 'undefined' ? globalThis : window));
