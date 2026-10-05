(function () {
  'use strict';
  const positive = /(?:^|[^а-яё])(?:успех|успеш|рост|вырос|побед|награ|достижен|улучшен|поддерж|одобрен|благодар|развити|надёжн|качествен|лидер|инновац|эффективн)[а-яё]*(?=$|[^а-яё])/giu;
  const negative = /(?:^|[^а-яё])(?:скандал|жалоб|кризис|штраф|нарушен|ошибк|провал|убыт|обвинен|судебн|неудач|отказ|недоволь|проблем|авари|увольнен|задержан|мошеннич)[а-яё]*(?=$|[^а-яё])/giu;

  function classifyMention(row) {
    const text = `${row.title || ''} ${row.description || ''}`.toLocaleLowerCase('ru-RU');
    const good = (text.match(positive) || []).length;
    const bad = (text.match(negative) || []).length;
    return bad > good ? 'negative' : good > bad ? 'positive' : 'neutral';
  }
  function countTones(rows) {
    const counts = { positive: 0, neutral: 0, negative: 0 };
    for (const row of rows) counts[classifyMention(row)] += 1;
    return counts;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { classifyMention, countTones };
  if (typeof document === 'undefined') return;

  const panel = document.createElement('section');
  panel.id = 'reputationPanel';
  panel.className = 'card reputation-panel';
  panel.hidden = true;
  panel.innerHTML = '<div class="reputation-head"><div><span class="workflow-kicker">РЕПУТАЦИЯ БРЕНДА</span><h3>Тональность упоминаний</h3><p id="reputationQuery"></p></div><span id="reputationTotal"></span></div><div class="reputation-bars" role="img" aria-label="Соотношение тональности публикаций"><div class="reputation-row positive"><span>Положительные</span><div class="reputation-track"><div></div></div><strong>0</strong></div><div class="reputation-row neutral"><span>Нейтральные</span><div class="reputation-track"><div></div></div><strong>0</strong></div><div class="reputation-row negative"><span>Отрицательные</span><div class="reputation-track"><div></div></div><strong>0</strong></div></div><p id="reputationNote">Автоматическая оценка по словам заголовка и описания; проверяйте контекст публикации.</p><details id="reputationNegative" hidden><summary>Посмотреть отрицательные публикации</summary><ul></ul></details>';
  document.querySelector('#keywordMonitor').after(panel);
  const $ = selector => panel.querySelector(selector);
  const liveTable = document.createElement('section');
  liveTable.id = 'liveMentions';
  liveTable.className = 'card live-mentions';
  liveTable.hidden = true;
  liveTable.innerHTML = '<div class="reputation-head"><div><h3>Проверенные публикации</h3><p id="liveMentionsCount"></p></div><button type="button" class="button secondary" id="liveMentionsAll">Вся таблица →</button></div><div class="table-wrap"><table><thead><tr><th>Публикация</th><th>Сайт</th><th>Дата</th></tr></thead><tbody></tbody></table></div>';
  panel.after(liveTable);
  liveTable.querySelector('#liveMentionsAll').addEventListener('click', () => document.querySelector('[data-tab="results"]').click());
  function render(job) {
    const rows = job.status === 'completed' ? job.results || [] : job.liveResults || [];
    panel.hidden = false;
    $('#reputationQuery').textContent = job.query?.original || '';
    const counts = countTones(rows);
    const total = rows.length;
    $('#reputationTotal').textContent = `${total} ${job.status === 'completed' ? 'публикаций' : 'проверено'}`;
    for (const tone of ['positive', 'neutral', 'negative']) {
      const row = $(`.reputation-row.${tone}`);
      const percentage = total ? Math.round(counts[tone] / total * 100) : 0;
      row.querySelector('.reputation-track div').style.width = `${percentage}%`;
      row.querySelector('strong').textContent = `${counts[tone]} · ${percentage}%`;
    }
    $('.reputation-bars').setAttribute('aria-label', `Положительных ${counts.positive}, нейтральных ${counts.neutral}, отрицательных ${counts.negative}`);
    $('#reputationNote').textContent = `${job.status === 'completed' ? 'Итоговая' : 'Предварительная'} автооценка по заголовку и описанию${job.status !== 'completed' && Number(job.liveMatches || 0) > rows.length ? ` · первые ${rows.length} из ${job.liveMatches}` : ''}. Проверяйте контекст.`;
    const negativeRows = rows.filter(row => /^https?:\/\//i.test(row.url || '') && classifyMention(row) === 'negative').slice(0, 8);
    const details = $('#reputationNegative');
    details.hidden = !negativeRows.length;
    details.querySelector('ul').replaceChildren(...negativeRows.map(row => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = row.title || row.url;
      item.append(link);
      return item;
    }));
    liveTable.hidden = job.status === 'completed';
    const limited = Number(job.liveMatches || 0) > rows.length;
    const preview = (limited ? rows.slice(0, 10) : rows.slice(-10).reverse()).filter(row => /^https?:\/\//i.test(row.url || ''));
    liveTable.querySelector('#liveMentionsCount').textContent = `${job.status === 'failed' || job.status === 'cancelled' ? 'Поиск прерван · ' : ''}${Number(job.liveMatches || rows.length)} предварительных · ${limited ? `${preview.length} из первых ${rows.length}` : `${preview.length} последних`}`;
    liveTable.querySelector('tbody').replaceChildren(...preview.map(row => {
      const tr = document.createElement('tr');
      const title = document.createElement('td');
      const link = document.createElement('a');
      link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = row.title || row.url;
      title.append(link);
      const site = document.createElement('td'); site.textContent = row.domain || '';
      const date = document.createElement('td'); date.textContent = row.date || '—';
      tr.append(title, site, date);
      return tr;
    }));
  }
  window.addEventListener('signal-job-selected', () => { panel.hidden = true; liveTable.hidden = true; $('#reputationNegative').open = false; });
  window.addEventListener('signal-job-updated', event => render(event.detail));
}());
