(function () {
  'use strict';
  const overlay = document.createElement('div');
  overlay.className = 'report-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="report-dialog" role="dialog" aria-modal="true" aria-labelledby="reportTitle">
    <header><div><span class="workflow-kicker">ОТЧЁТ ПО РЕЗУЛЬТАТАМ</span><h2 id="reportTitle">Сформировать отчёт</h2></div><button type="button" class="report-close" aria-label="Закрыть">×</button></header>
    <nav class="report-steps" aria-label="Шаги формирования отчёта"><span data-step="1">1 · Выбор</span><span data-step="2">2 · Формирование</span><span data-step="3">3 · Скачивание</span></nav>
    <form id="reportForm" class="report-form">
      <label>Результаты<select name="scope"><option value="current">Выбранный поиск</option><option value="all">Все поиски</option></select></label>
      <label>Тип отчёта<select name="format"><option value="xlsx">Таблица Excel</option><option value="csv">Таблица CSV</option><option value="txt">Список ссылок (текстовый файл)</option></select></label>
      <label>Период публикаций: от<input name="from" type="date"></label><label>До<input name="to" type="date"></label>
      <p class="report-help">Без дат в отчёт войдут все найденные ссылки. Для периода учитывается дата публикации; ссылки без даты в выборку не входят.</p>
      <button class="button primary" type="submit">Сформировать</button>
    </form>
    <section class="report-progress" hidden role="status" aria-live="polite"><div class="report-loader" aria-hidden="true"></div><strong>Формируем отчёт…</strong><p>Подбираем ссылки за указанный период и готовим файл для скачивания.</p><span id="reportElapsed">Прошло: 0 с</span></section>
      <section class="report-done" hidden role="status" aria-live="polite"><strong>Отчёт сформирован</strong><p id="reportCount"></p><p id="reportPeriod" class="report-period"></p><a id="reportDownload" class="button primary" download>↓ Скачать</a><button type="button" class="button secondary" id="reportAgain">Другой отчёт</button><div class="report-links"><strong>Собранные ссылки</strong><p id="reportLinksHint"></p><ol id="reportLinks"></ol></div></section>
    <p id="reportError" class="report-error" role="alert" hidden></p>
  </div>`;
  document.body.append(overlay);
  const $ = selector => overlay.querySelector(selector);
  const form = $('#reportForm');
  let jobId = null;
  let controller = null;
  let ticker = null;
  function size() { $('.report-dialog').style.width = `${Math.min(720, Math.max(0, window.innerWidth - 32))}px`; }
  function renderLinks(rows) {
    const list = $('#reportLinks');
    list.replaceChildren();
    $('#reportLinksHint').textContent = rows.length ? `${rows.length} ссылок в отчёте. Нажмите на публикацию, чтобы открыть её.` : 'Для выбранного поиска и периода сохранённых ссылок нет.';
    const sentiments = { positive: 'Положительная', neutral: 'Нейтральная', negative: 'Отрицательная' };
    for (const row of rows) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      const url = String(row.url || '');
      if (!/^https?:\/\//i.test(url)) continue;
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = row.title || url;
      const address = document.createElement('small'); address.textContent = url;
      const tone = document.createElement('span'); tone.textContent = sentiments[row.sentiment] || 'Тональность не определена';
      item.append(link, address, tone);
      list.append(item);
    }
  }
  window.addEventListener('resize', size);
  function stage(number) {
    overlay.querySelectorAll('[data-step]').forEach(item => item.classList.toggle('active', Number(item.dataset.step) === number));
    form.hidden = number !== 1;
    $('.report-progress').hidden = number !== 2;
    $('.report-done').hidden = number !== 3;
  }
  function close() {
    controller?.abort();
    controller = null;
    clearInterval(ticker);
    overlay.hidden = true;
  }
  $('.report-close').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) close(); });
  $('#reportAgain').addEventListener('click', () => stage(1));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const { scope, format, from, to } = Object.fromEntries(new FormData(form));
    $('#reportError').hidden = true;
    if (scope === 'current' && !jobId) { $('#reportError').textContent = 'Сначала выберите поиск из истории или выполните новый.'; $('#reportError').hidden = false; return; }
    if (from && to && from > to) { $('#reportError').textContent = 'Дата начала позже даты окончания.'; $('#reportError').hidden = false; return; }
    stage(2);
    const started = Date.now();
    $('#reportElapsed').textContent = 'Прошло: 0 с';
    const currentTicker = setInterval(() => { $('#reportElapsed').textContent = `Прошло: ${Math.floor((Date.now() - started) / 1000)} с`; }, 1000);
    ticker = currentTicker;
    const currentController = new AbortController();
    controller = currentController;
    try {
      const response = await fetch('/api/export/report', {
        method: 'POST', signal: currentController.signal,
        headers: { 'Content-Type': 'application/json', ...(window.signalAppToken ? { 'X-App-Token': window.signalAppToken } : {}) },
        body: JSON.stringify({ scope, format, from: from || null, to: to || null, jobId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось сформировать отчёт.');
      if (overlay.hidden || controller !== currentController) return;
       $('#reportCount').textContent = `Найдено ссылок: ${result.count}. Файл: ${result.file}`;
       $('#reportPeriod').textContent = from || to ? `Дата публикации: ${from || 'начало'} — ${to || 'конец'}` : 'Период публикаций: без ограничения';
       $('#reportDownload').href = result.url;
       $('#reportDownload').download = result.file;
       renderLinks(result.results || []);
      stage(3);
    } catch (error) {
      if (error.name !== 'AbortError' && !overlay.hidden && controller === currentController) {
        stage(1);
        $('#reportError').textContent = error.message;
        $('#reportError').hidden = false;
      }
    } finally { clearInterval(currentTicker); if (ticker === currentTicker) ticker = null; if (controller === currentController) controller = null; }
  });
  window.SignalReport = { open(scope, selectedId) {
    jobId = selectedId;
    form.elements.scope.value = scope === 'all' ? 'all' : 'current';
    $('#reportError').hidden = true;
    stage(1);
    size();
    overlay.hidden = false;
    form.elements.format.focus();
  } };
}());
