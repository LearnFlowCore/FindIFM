(function () {
  'use strict';
  const overlay = document.createElement('div');
  overlay.className = 'semantic-overlay'; overlay.hidden = true;
  overlay.innerHTML = `<section class="semantic-dialog" role="dialog" aria-modal="true" aria-labelledby="semanticTitle">
    <header><div><span class="workflow-kicker">АНАЛИЗ ОТКРЫТЫХ ИСТОЧНИКОВ</span><h2 id="semanticTitle">Сводка с источниками</h2></div><button class="semantic-close" type="button" aria-label="Закрыть">×</button></header>
    <form class="semantic-form"><label>Что выяснить по найденным публикациям?<textarea name="question" maxlength="500" rows="3" required></textarea></label><button class="button primary" type="submit">Составить сводку</button></form>
    <p class="semantic-state" role="status"></p><div class="semantic-answer" hidden></div><ol class="semantic-sources" hidden></ol>
    <small>Выводы модели проверяйте по указанным первоисточникам. Дата без подтверждения не определяется автоматически.</small>
  </section>`;
  document.body.append(overlay);
  const $ = selector => overlay.querySelector(selector);
  let selectedJobId = null;
  let source = null;
  let controller = null;
  window.addEventListener('signal-job-selected', event => { selectedJobId = event.detail.jobId; });
  function close() { controller?.abort(); overlay.hidden = true; }
  $('.semantic-close').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) close(); });
  const button = document.createElement('button');
  button.className = 'button secondary'; button.type = 'button'; button.textContent = '✦ Сводка ИИ';
  document.querySelector('#resultsView .inline-actions').prepend(button);
  button.addEventListener('click', () => { open({ jobId: selectedJobId }); if (!selectedJobId) $('.semantic-state').textContent = 'Сначала выполните поиск или выберите запуск в истории.'; });
  function open(input) {
    source = input;
    $('.semantic-form').elements.question.value = input.question || document.querySelector('#searchForm [name="query"]').value;
    $('.semantic-state').textContent = '';
    $('.semantic-answer').hidden = true;
    $('.semantic-sources').hidden = true;
    overlay.hidden = false;
    $('.semantic-form').elements.question.focus();
  }
  $('.semantic-form').addEventListener('submit', async event => {
    event.preventDefault();
    controller?.abort();
    const active = new AbortController(); controller = active;
    const submit = $('.semantic-form button'); submit.disabled = true;
    $('.semantic-state').textContent = 'Модель изучает найденные фрагменты…';
    $('.semantic-answer').hidden = true; $('.semantic-sources').hidden = true;
    try {
      const response = await fetch('/api/semantic/summary', {
        method: 'POST', signal: active.signal,
        headers: { 'Content-Type': 'application/json', ...(window.signalAppToken ? { 'X-App-Token': window.signalAppToken } : {}) },
        body: JSON.stringify({ ...source, rows: source.rows?.slice(0, 12), question: $('.semantic-form').elements.question.value.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось подготовить сводку.');
      if (overlay.hidden || controller !== active) return;
      $('.semantic-state').textContent = 'Сводка готова. Номера в тексте соответствуют источникам ниже.';
      $('.semantic-answer').textContent = result.answer;
      $('.semantic-answer').hidden = false;
      const list = $('.semantic-sources'); list.replaceChildren();
      for (const item of result.sources) {
        const entry = document.createElement('li');
        const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = item.title || item.url;
        const excerpt = document.createElement('p'); excerpt.textContent = `${item.date || 'Дата не указана'} · ${item.excerpt}`;
        entry.append(link, excerpt); list.append(entry);
      }
      list.hidden = false;
    } catch (error) {
      if (error.name !== 'AbortError' && !overlay.hidden && controller === active) $('.semantic-state').textContent = error.message;
    } finally { if (controller === active) { controller = null; submit.disabled = false; } }
  });
  window.SignalSemantic = { open };
}());
