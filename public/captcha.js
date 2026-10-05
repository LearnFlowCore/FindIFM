(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const jobId = new URLSearchParams(location.search).get('job');
  const validJob = /^[0-9a-f-]{36}$/i.test(jobId || '');
  const storageKey = `signal-captcha-${jobId}`;
  let token = validJob ? sessionStorage.getItem(storageKey) : null;
  let appToken = '';
  let waiting = true;
  let dragging = false;
  let loading = false;
  let actions = Promise.resolve();
  let lastMove = 0;
  const img = $('image');
  img.addEventListener('load', () => $('screen').classList.add('ready'));
  img.addEventListener('error', () => {
    $('screen').classList.remove('ready');
    $('loading').textContent = 'Не удалось показать изображение. Нажмите «Обновить изображение».';
  });
  function closeAfterSuccess() {
    setHint('Яндекс принял ответ. Поиск продолжается в основной вкладке; это окно сейчас закроется.');
    setTimeout(() => window.close(), 1200);
  }

  const setHint = message => { $('hint').textContent = message; };
  function setStatus(message, kind = '') { $('status').textContent = message; $('status').className = `status ${kind}`; }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(path, {
        ...options,
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(appToken ? { 'X-App-Token': appToken } : {}), ...(options.headers || {}) },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Ошибка сервера ${response.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }
  function access() { if (!token) throw new Error('Ожидаем доступ от основной вкладки. Откройте это окно кнопкой в разделе «Результаты».'); }
  function captchaRequest(action) {
    access();
    return request(`/api/jobs/${encodeURIComponent(jobId)}/captcha`, {
      ...(action ? { method: 'POST', body: JSON.stringify(action) } : {}),
      headers: { 'X-Captcha-Token': token },
    });
  }
  function send(action) {
    if (!waiting) return Promise.resolve();
    actions = actions.catch(() => {}).then(() => captchaRequest(action));
    actions.catch(error => setHint(`Не удалось передать действие: ${error.message}`));
    return actions;
  }
  function coords(event) {
    const img = $('image');
    const rect = img.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(img.naturalWidth - 1, (event.clientX - rect.left) * img.naturalWidth / rect.width))),
      y: Math.round(Math.max(0, Math.min(img.naturalHeight - 1, (event.clientY - rect.top) * img.naturalHeight / rect.height))),
    };
  }
  async function refreshImage() {
    if (!waiting || !token || loading || dragging) return;
    loading = true;
    try {
      const screenshot = await captchaRequest();
      if (waiting && !dragging) { img.src = screenshot.image; setStatus('Ожидаем вашего ответа'); }
    } catch (error) {
      if (waiting) setHint(`Не удалось обновить изображение: ${error.message}`);
    } finally { loading = false; }
  }
  async function checkJob() {
    if (!validJob || !waiting) return;
    try {
      const job = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (!waiting) return;
      if (job.status === 'waiting_captcha') {
        setStatus('Ожидаем вашего ответа');
      } else if (['completed', 'cancelled', 'failed'].includes(job.status)) {
        waiting = false;
        sessionStorage.removeItem(storageKey);
        setStatus(job.status === 'completed' ? 'Поиск завершён' : job.status === 'cancelled' ? 'Поиск остановлен' : 'Ошибка поиска', job.status === 'failed' ? 'error' : 'done');
        if (job.status === 'completed') closeAfterSuccess();
        else setHint(job.error || job.message || 'Откройте основную вкладку, чтобы посмотреть результат.');
      } else if (job.status === 'running') {
        waiting = false;
        sessionStorage.removeItem(storageKey);
        setStatus('Проверка пройдена ✓', 'done');
        closeAfterSuccess();
      }
    } catch (error) { setHint(`Нет связи с поиском: ${error.message}`); }
  }

  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== window.opener || !validJob) return;
    if (event.data?.type !== 'signal-captcha-access' || event.data.jobId !== jobId || typeof event.data.token !== 'string') return;
    token = event.data.token;
    appToken = event.data.appToken || '';
    sessionStorage.setItem(storageKey, token);
    refreshImage();
    checkJob();
  });
  if (!validJob) { waiting = false; setStatus('Некорректная задача', 'error'); setHint('Откройте окно кнопкой из активного поиска.'); return; }
  if (window.opener) window.opener.postMessage({ type: 'signal-captcha-ready', jobId }, location.origin);
  if (!token) setHint('Получаем доступ к проверке от основной вкладки...');

  img.addEventListener('pointerdown', event => {
    if (!waiting || !token || !img.naturalWidth) return;
    event.preventDefault();
    img.setPointerCapture(event.pointerId);
    dragging = true;
    lastMove = 0;
    setHint('Действие передаётся на страницу Яндекса. После выполнения задания нажмите «Отправить ответ».');
    send({ type: 'down', ...coords(event) });
  });
  img.addEventListener('pointermove', event => {
    if (!dragging || Date.now() - lastMove < 65) return;
    lastMove = Date.now();
    send({ type: 'move', ...coords(event) });
  });
  function finishDrag(event) {
    if (!dragging) return;
    dragging = false;
    send({ type: 'up', ...coords(event) }).then(() => setTimeout(refreshImage, 400)).catch(() => {});
  }
  img.addEventListener('pointerup', finishDrag);
  img.addEventListener('pointercancel', finishDrag);
  img.addEventListener('wheel', event => {
    if (!waiting || !token || !img.naturalWidth) return;
    event.preventDefault();
    send({ type: 'scroll', ...coords(event), value: event.deltaY });
  }, { passive: false });

  $('type').addEventListener('click', async () => {
    const input = $('answer');
    if (!input.value) return;
    try { await send({ type: 'text', value: input.value }); input.value = ''; setHint('Ответ введён на странице Яндекса. Нажмите «Отправить ответ».'); }
    catch { /* Сообщение об ошибке показывает send. */ }
  });
  $('answer').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('type').click(); } });
  for (const [id, key] of [['enter', 'Enter'], ['tab', 'Tab'], ['backspace', 'Backspace']]) {
    $(id).addEventListener('click', () => {
      if (id === 'enter' && $('answer').value.trim()) {
        setHint('Сначала нажмите «Ввести ответ», затем «Отправить ответ».');
        return;
      }
      send({ type: 'key', value: key }).then(() => { if (id === 'enter') setHint('Ответ отправлен. Ожидаем результат проверки Яндекса…'); }).catch(() => {});
    });
  }
  for (const [id, delta] of [['scrollUp', -500], ['scrollDown', 500]]) {
    $(id).addEventListener('click', () => send({ type: 'scroll', x: 500, y: 350, value: delta }));
  }
  $('refresh').addEventListener('click', refreshImage);
  for (const [id, fit] of [['fit', true], ['fullSize', false]]) {
    $(id).addEventListener('click', () => {
      $('screen').classList.toggle('fit', fit);
      $('fit').setAttribute('aria-pressed', String(fit));
      $('fullSize').setAttribute('aria-pressed', String(!fit));
    });
  }
  checkJob();
  refreshImage();
  setInterval(checkJob, 2000);
  setInterval(refreshImage, 1600);
}());
