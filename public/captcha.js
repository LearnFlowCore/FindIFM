(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const jobId = new URLSearchParams(location.search).get('job');
  const validJob = /^[0-9a-f-]{36}$/i.test(jobId || '');
  const storageKey = `signal-captcha-${jobId}`;
  let token = validJob ? sessionStorage.getItem(storageKey) : null;
  let appToken = validJob ? sessionStorage.getItem(`signal-captcha-app-${jobId}`) || '' : '';
  let waiting = true;
  let dragging = false;
  let mousePressed = false;
  let loading = false;
  let submitting = false;
  let refreshTimers = [];
  let actions = Promise.resolve();
  let lastMove = 0;
  let selectedPoint = null;
  let screenshotWidth = 0;
  let screenshotHeight = 0;
  let cookieDismissed = false;
  const img = $('image');
  $('showCookiePage').addEventListener('click', () => { cookieDismissed = true; $('cookieOverlay').hidden = true; });
  $('acceptCookies').addEventListener('click', async () => {
    $('acceptCookies').disabled = true;
    $('cookieStatus').textContent = 'Передаём согласие на страницу Яндекса…';
    try {
      await send({ type: 'accept_cookies' });
      cookieDismissed = false;
      $('cookieOverlay').hidden = true;
      $('cookieStatus').textContent = '';
      setHint('Согласие передано Яндексу. Теперь можно пройти CAPTCHA.');
      refreshImage();
    } catch (error) { $('cookieStatus').textContent = error.message; }
    finally { $('acceptCookies').disabled = false; }
  });
  img.addEventListener('load', () => $('screen').classList.add('ready'));
  img.addEventListener('error', () => {
    $('screen').classList.remove('ready');
    $('loading').textContent = 'Не удалось показать изображение. Нажмите «Обновить изображение».';
  });
  function closeAfterSuccess() {
    finishSubmitFeedback();
    setHint('Яндекс принял ответ. Поиск продолжается в основной вкладке; это окно сейчас закроется.');
    setTimeout(() => window.close(), 1200);
  }

  const setHint = message => { $('hint').textContent = message; };
  function setStatus(message, kind = '') { $('status').textContent = message; $('status').className = `status ${kind}`; }
  function finishSubmitFeedback() {
    submitting = false;
    $('screen').classList.remove('submitting');
    $('submitFeedback').hidden = true;
    $('type').disabled = false;
    $('enter').disabled = false;
  }
  async function submitAnswer(action, button) {
    if (submitting || !waiting) return;
    refreshTimers.forEach(clearTimeout);
    refreshTimers = [];
    submitting = true;
    $('screen').classList.add('submitting');
    $('submitFeedback').hidden = false;
    $('submitMessage').textContent = 'Передаём ответ Яндексу…';
    if (button) button.disabled = true;
    setStatus('Отправляем ответ…');
    try {
      await action();
      $('submitMessage').textContent = 'Проверяем ответ Яндекса…';
      setStatus('Проверяем ответ…');
      // Покажем настоящий ответ Яндекса (в том числе галочку), пока проверка
      // не закрыла окно CAPTCHA и не возобновила поиск.
      await refreshImage();
      await checkJob();
      if (waiting) {
        setHint('Ответ отправлен. Если Яндекс показывает новое задание, продолжите проверку.');
        refreshTimers = [350, 1000, 1800].map(delay => setTimeout(() => { refreshImage(); checkJob(); }, delay));
      }
    } catch (error) { setHint(`Не удалось отправить ответ: ${error.message}`); }
    finally { finishSubmitFeedback(); }
  }
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
      x: Math.round(Math.max(0, Math.min(screenshotWidth - 1, (event.clientX - rect.left) * screenshotWidth / rect.width))),
      y: Math.round(Math.max(0, Math.min(screenshotHeight - 1, (event.clientY - rect.top) * screenshotHeight / rect.height))),
    };
  }
  async function refreshImage() {
    if (!waiting || !token || loading || dragging) return;
    loading = true;
    try {
      const screenshot = await captchaRequest();
      if (waiting && !dragging) {
        screenshotWidth = screenshot.width;
        screenshotHeight = screenshot.height;
        img.src = screenshot.image; if (!submitting) setStatus('Ожидаем вашего ответа');
        if (!screenshot.cookieConsent) cookieDismissed = false;
        const showConsent = Boolean(screenshot.cookieConsent) && !cookieDismissed;
        const overlay = $('cookieOverlay');
        if (showConsent && overlay.hidden) { overlay.hidden = false; $('acceptCookies').focus(); }
        else if (!showConsent) overlay.hidden = true;
      }
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
        if (!submitting) setStatus('Ожидаем вашего ответа');
      } else if (['completed', 'cancelled', 'failed'].includes(job.status)) {
        waiting = false;
        refreshTimers.forEach(clearTimeout);
        refreshTimers = [];
        finishSubmitFeedback();
        $('cookieOverlay').hidden = true;
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(`signal-captcha-app-${jobId}`);
        setStatus(job.status === 'completed' ? 'Поиск завершён' : job.status === 'cancelled' ? 'Поиск остановлен' : 'Ошибка поиска', job.status === 'failed' ? 'error' : 'done');
        if (job.status === 'completed') closeAfterSuccess();
        else setHint(job.error || job.message || 'Откройте основную вкладку, чтобы посмотреть результат.');
      } else if (job.status === 'running') {
        waiting = false;
        refreshTimers.forEach(clearTimeout);
        refreshTimers = [];
        finishSubmitFeedback();
        $('cookieOverlay').hidden = true;
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(`signal-captcha-app-${jobId}`);
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
    if (!event.isPrimary || !waiting || submitting || !token || !screenshotWidth) return;
    if (event.pointerType === 'mouse') {
      if (event.button === 0) { mousePressed = true; selectedPoint = coords(event); img.setPointerCapture(event.pointerId); img.focus(); }
      return;
    }
    event.preventDefault();
    img.setPointerCapture(event.pointerId);
    dragging = true;
    lastMove = 0;
    selectedPoint = coords(event);
    setHint('Касание передаётся на страницу Яндекса.');
    send({ type: 'down', ...coords(event) });
  });
  img.addEventListener('pointermove', event => {
    if (event.pointerType === 'mouse' && screenshotWidth) selectedPoint = coords(event);
    if (!dragging || Date.now() - lastMove < 65) return;
    lastMove = Date.now();
    send({ type: 'move', ...coords(event) });
  });
  function finishDrag(event) {
    if (event.pointerType === 'mouse') {
      const clicked = mousePressed && event.button === 0 && !submitting && waiting && token;
      mousePressed = false;
      if (clicked) {
        selectedPoint = coords(event);
        submitAnswer(() => send({ type: 'click', ...selectedPoint }));
      }
      return;
    }
    if (!dragging) return;
    dragging = false;
    submitAnswer(() => send({ type: 'up', ...coords(event) }));
  }
  img.addEventListener('pointerup', finishDrag);
  img.addEventListener('pointercancel', () => { mousePressed = false; if (!dragging) return; dragging = false; send({ type: 'up', ...selectedPoint }).catch(() => {}); });
  img.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key) || !selectedPoint || submitting || !waiting || !token) return;
    event.preventDefault();
    submitAnswer(() => send({ type: 'click', ...selectedPoint }));
  });
  img.addEventListener('wheel', event => {
    if (!waiting || !token || !img.naturalWidth) return;
    event.preventDefault();
    send({ type: 'scroll', ...coords(event), value: event.deltaY }).then(() => setTimeout(refreshImage, 250)).catch(() => {});
  }, { passive: false });

  $('type').addEventListener('click', async () => {
    const input = $('answer');
    if (!input.value.trim()) { input.focus(); return; }
    if (submitting) return;
    await submitAnswer(async () => {
      await send({ type: 'text', value: input.value.trim() });
      await send({ type: 'key', value: 'Enter' });
      input.value = '';
    }, $('type'));
  });
  $('answer').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('type').click(); } });
  for (const [id, key] of [['enter', 'Enter'], ['tab', 'Tab'], ['backspace', 'Backspace']]) {
    $(id).addEventListener('click', () => {
      if (id === 'enter' && $('answer').value.trim()) {
        setHint('Для текстового ответа нажмите «Отправить текст».');
        return;
      }
      if (id === 'enter') submitAnswer(() => send({ type: 'key', value: key }), $(id));
      else send({ type: 'key', value: key }).catch(() => {});
    });
  }
  for (const [id, delta] of [['scrollUp', -500], ['scrollDown', 500]]) {
    $(id).addEventListener('click', () => send({ type: 'scroll', x: 500, y: 350, value: delta }).then(() => setTimeout(refreshImage, 250)).catch(() => {}));
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
  setInterval(checkJob, 1000);
}());
