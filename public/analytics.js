(function () {
  'use strict';
  const panel = document.createElement('section');
  panel.id = 'analyticsPanel';
  panel.className = 'card analytics-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="analytics-head"><div><span class="workflow-kicker">АНАЛИТИКА / В РЕАЛЬНОМ ВРЕМЕНИ</span><h3>Скорость реагирования</h3><p id="analyticsQuery"></p></div><span id="analyticsStatus" role="status">Загрузка</span></div>
    <div class="analytics-metrics">
      <div class="analytics-metric" id="spikeMetric"><span>От всплеска до уведомления</span><strong id="spikeTime">Не измерено</strong><small id="spikeState">Ожидание отметки всплеска</small><div class="analytics-track"><div id="spikeBar"></div></div><small>Шкала: 60 минут</small></div>
      <div class="analytics-metric" id="responseMetric"><span>От уведомления до реакции ведомства</span><strong id="responseTime">Не измерено</strong><small id="responseState">Ожидание отметки уведомления</small><div class="analytics-track"><div id="responseBar"></div></div><small>Шкала: 4 часа</small></div>
    </div>
    <div class="analytics-chart" aria-label="График этапов от всплеска до реакции">
      <div class="analytics-chart-heading"><strong>График этапов</strong><span>Красный — всплеск · синий — уведомление · зелёный — реакция</span></div>
      <svg id="analyticsSvg" viewBox="0 0 1000 215" role="img" aria-label="Схема этапов всплеска, уведомления и реакции ведомства, не в масштабе времени">
        <defs>
          <linearGradient id="signalFirst" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#ef4655"/><stop offset="1" stop-color="#3f8de1"/></linearGradient>
          <linearGradient id="signalSecond" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#3f8de1"/><stop offset="1" stop-color="#20ae83"/></linearGradient>
          <filter id="signalGlow"><feGaussianBlur stdDeviation="5"/></filter>
        </defs>
        <path d="M50 160 H950" stroke="#d9e3f2" stroke-width="3"/>
        <path id="firstLine" fill="none" stroke="url(#signalFirst)" stroke-width="7" stroke-linecap="round"/>
        <path id="secondLine" fill="none" stroke="url(#signalSecond)" stroke-width="7" stroke-linecap="round"/>
        <circle id="peakGlow" cx="50" cy="60" r="23" fill="#f34e59" opacity=".35" filter="url(#signalGlow)"/>
        <circle id="peakPoint" cx="50" cy="60" r="11" fill="#ec394b" stroke="#fff" stroke-width="3"/>
        <circle id="noticePoint" cx="500" cy="110" r="9" fill="#3f8de1" stroke="#fff" stroke-width="3"/>
        <circle id="responsePoint" cx="950" cy="125" r="9" fill="#20ae83" stroke="#fff" stroke-width="3"/>
        <text x="50" y="194" fill="#b8384a" text-anchor="middle">ВСПЛЕСК</text>
        <text id="noticeLabel" x="500" y="194" fill="#346db8" text-anchor="middle">УВЕДОМЛЕНИЕ</text>
        <text x="950" y="194" fill="#148667" text-anchor="middle">РЕАКЦИЯ</text>
      </svg>
      <p id="chartCaption">Схема не в масштабе времени. Укажите время всплеска, чтобы увидеть движение по графику.</p>
    </div>
    <p class="analytics-note">Отметьте фактическое время событий. Таймеры идут независимо: первый останавливается при уведомлении, второй — только при реакции ведомства. Завершение поиска само по себе не считается уведомлением или реакцией.</p>
    <form id="analyticsForm" class="analytics-form">
      <label>Начало всплеска<input type="datetime-local" name="spikeAt"></label>
      <label>Уведомление отправлено<input type="datetime-local" name="notifiedAt"></label>
      <label>Реакция ведомства<input type="datetime-local" name="responseAt"></label>
      <button type="submit" class="button secondary">Сохранить время</button>
    </form>
    <div class="analytics-quick"><button type="button" data-mark-event="spikeAt" class="mini-button">Всплеск сейчас</button><button type="button" data-mark-event="notifiedAt" class="mini-button">Уведомлено сейчас</button><button type="button" data-mark-event="responseAt" class="mini-button">Реакция сейчас</button></div>
    <p id="analyticsMessage" role="status"></p>`;
  document.querySelector('#resultsView .section-intro').after(panel);
  const $ = selector => panel.querySelector(selector);
  const form = $('#analyticsForm');
  let selected = null;
  let data = null;
  let requestNumber = 0;
  let editing = false;
  const header = () => window.signalAppToken ? { 'X-App-Token': window.signalAppToken } : {};
  function duration(seconds) {
    if (seconds === null) return 'Не измерено';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return hours ? `${hours} ч ${String(minutes).padStart(2, '0')} мин ${String(seconds % 60).padStart(2, '0')} с` : `${minutes} мин ${String(seconds % 60).padStart(2, '0')} с`;
  }
  function local(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function paint() {
    if (!data) return;
    $('#analyticsQuery').textContent = `${data.query} · ${data.resultsCount} публикаций · ${data.sourcesCount} источников · ${data.status}`;
    const stages = [
      { start: data.spikeAt, end: data.notifiedAt, time: '#spikeTime', state: '#spikeState', bar: '#spikeBar', card: '#spikeMetric', wait: 'Ожидание отметки всплеска', next: 'Идёт время до уведомления', seconds: 3600 },
      { start: data.notifiedAt, end: data.responseAt, time: '#responseTime', state: '#responseState', bar: '#responseBar', card: '#responseMetric', wait: 'Ожидание отметки уведомления', next: 'Идёт время до реакции', seconds: 14400 },
    ];
    for (const stage of stages) {
      const elapsed = stage.start ? Math.max(0, Math.floor((Date.parse(stage.end || new Date().toISOString()) - Date.parse(stage.start)) / 1000)) : null;
      $(stage.time).textContent = duration(elapsed);
      $(stage.state).textContent = !stage.start ? stage.wait : stage.end ? 'Интервал измерен' : stage.next;
      $(stage.card).classList.toggle('active', Boolean(stage.start && !stage.end));
      $(stage.card).classList.toggle('measured', Boolean(stage.start && stage.end));
      $(stage.bar).style.width = `${elapsed === null ? 0 : Math.min(100, elapsed / stage.seconds * 100)}%`;
    }
    const spike = data.spikeAt ? Date.parse(data.spikeAt) : null;
    const notice = data.notifiedAt ? Date.parse(data.notifiedAt) : null;
    const reaction = data.responseAt ? Date.parse(data.responseAt) : null;
    const now = Date.now();
    const end = reaction || now;
    const total = Math.max(1, end - (spike || notice || now));
    const noticeX = spike && notice ? Math.min(820, Math.max(180, 50 + (notice - spike) / total * 900)) : 500;
    $('#peakPoint').style.display = $('#peakGlow').style.display = spike ? '' : 'none';
    $('#noticePoint').style.display = notice ? '' : 'none';
    $('#responsePoint').style.display = reaction ? '' : 'none';
    $('#noticeLabel').style.opacity = notice ? '1' : '.45';
    $('#noticePoint').setAttribute('cx', noticeX);
    $('#noticeLabel').setAttribute('x', noticeX);
    $('#firstLine').setAttribute('d', spike ? `M50 60 Q${Math.round((notice ? noticeX : 950) * .55)} 53 ${notice ? noticeX : 950} 110` : '');
    $('#secondLine').setAttribute('d', notice ? `M${noticeX} 110 Q${Math.round((noticeX + 950) / 2)} 90 950 125` : '');
    $('#firstLine').classList.toggle('moving', Boolean(spike && !notice));
    $('#secondLine').classList.toggle('moving', Boolean(notice && !reaction));
    $('#peakGlow').classList.toggle('pulsing', Boolean(spike));
    $('#chartCaption').textContent = 'Схема не в масштабе времени. ' + (!spike && !notice ? 'Укажите время всплеска, чтобы увидеть движение по графику.'
      : !spike ? 'Время всплеска не измерено; время уведомления и реакции отображается отдельно.'
      : !notice ? 'С момента всплеска идёт отсчёт до уведомления.'
        : !reaction ? 'Время до уведомления зафиксировано; идёт отдельный отсчёт до реакции ведомства.'
          : 'Оба интервала завершены и измерены независимо.');
  }
  async function fetchAnalytics(id) {
    const number = ++requestNumber;
    try {
      const response = await fetch(`/api/analytics/${encodeURIComponent(id)}`, { headers: header() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось получить аналитику');
      if (number !== requestNumber || selected !== id) return;
      data = result;
      panel.hidden = false;
      $('#analyticsStatus').textContent = 'Обновлено';
      if (!editing) for (const field of ['spikeAt', 'notifiedAt', 'responseAt']) form.elements[field].value = local(result[field]);
      paint();
    } catch (error) { if (number === requestNumber) $('#analyticsMessage').textContent = error.message; }
  }
  function select(id) {
    if (!id) return;
    selected = id;
    editing = false;
    data = null;
    $('#analyticsMessage').textContent = '';
    $('#analyticsStatus').textContent = 'Загрузка';
    panel.hidden = false;
    fetchAnalytics(id);
  }
  async function save(changes) {
    if (!selected) return;
    ++requestNumber;
    const jobId = selected;
    $('#analyticsMessage').textContent = 'Сохраняем...';
    try {
      const response = await fetch(`/api/analytics/${encodeURIComponent(jobId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...header() }, body: JSON.stringify(changes),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить время');
      if (selected !== jobId) return;
      data = result;
      editing = false;
      $('#analyticsStatus').textContent = 'Сохранено';
      for (const field of ['spikeAt', 'notifiedAt', 'responseAt']) form.elements[field].value = local(result[field]);
      $('#analyticsMessage').textContent = 'Отметки сохранены';
      paint();
    } catch (error) { $('#analyticsMessage').textContent = error.message; }
  }
  form.addEventListener('input', () => { editing = true; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const changes = {};
    for (const field of ['spikeAt', 'notifiedAt', 'responseAt']) {
      const value = form.elements[field].value;
      changes[field] = value ? new Date(value).toISOString() : null;
    }
    save(changes);
  });
  panel.addEventListener('click', event => {
    const field = event.target.closest('[data-mark-event]')?.dataset.markEvent;
    if (field) save({ [field]: new Date().toISOString() });
  });
  window.addEventListener('signal-job-selected', event => select(event.detail.jobId));
  // Незакрытая вкладка обновляет два таймера без опроса сервера каждую секунду.
  setInterval(paint, 1000);
  setInterval(() => { if (selected && !panel.hidden) fetchAnalytics(selected); }, 10000);
}());
