(function () {
  'use strict';
  const view = document.getElementById('voiceView');
  const $ = selector => view.querySelector(selector);
  const selectionKey = 'signal-voice-ministries-v1';
  const reachKey = 'signal-voice-reach-v1';
  const number = value => Number(value).toLocaleString('ru-RU');
  function stored(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  const previousSelection = stored(selectionKey, []);
  let selected = new Set(Array.isArray(previousSelection) ? previousSelection.filter(x => typeof x === 'string') : []);
  let reach = stored(reachKey, {});
  if (!reach || typeof reach !== 'object' || Array.isArray(reach)) reach = {};
  let available = [];
  let groups = [];
  let requestNumber = 0;
  const scope = query => JSON.stringify([query, $('#voiceFrom').value, $('#voiceTo').value]);
  const headers = () => window.signalAppToken ? { 'X-App-Token': window.signalAppToken } : {};

  function render() {
    const choices = $('#voiceChoices');
    choices.replaceChildren();
    for (const group of available) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = group.query;
      checkbox.checked = selected.has(group.query);
      label.append(checkbox, document.createTextNode(group.query));
      choices.append(label);
    }
    if (!available.length) choices.textContent = 'Сначала выполните поиски по названиям министерств.';
    const chosen = available.filter(group => selected.has(group.query));
    const counts = new Map(groups.map(group => [group.query, group]));
    const total = chosen.reduce((sum, group) => sum + (counts.get(group.query)?.mentions || 0), 0);
    $('#voiceSummary').hidden = !chosen.length;
    $('#voiceSummary').textContent = `${chosen.length} ведомств · ${number(total)} упоминаний без повторов внутри запросов${total ? '' : ' за этот период'}`;
    $('#voiceStatus').textContent = !available.length ? '' : !chosen.length
      ? 'Выберите не менее двух запросов для сравнения министерств.'
      : chosen.length < 2 ? 'Для сравнения долей выберите ещё одно министерство.'
        : total ? 'SOV рассчитана среди выбранных запросов, а не всего информационного поля.' : 'За выбранный период публикаций нет.';
    const container = $('#voiceRows');
    container.replaceChildren();
    for (const group of chosen) {
      const count = counts.get(group.query) || { mentions: 0, sources: 0 };
      const comparable = chosen.length >= 2 && total > 0;
      const share = comparable ? count.mentions / total * 100 : 0;
      const card = document.createElement('article');
      card.className = 'voice-card';
      const heading = document.createElement('div'); heading.className = 'voice-heading';
      const title = document.createElement('strong'); title.textContent = group.query;
      const percent = document.createElement('b'); percent.textContent = comparable ? `${share.toFixed(1)}% SOV` : '— SOV';
      heading.append(title, percent);
      const track = document.createElement('div'); track.className = 'voice-track';
      const bar = document.createElement('span'); bar.style.width = `${share}%`; track.append(bar);
      const details = document.createElement('p'); details.className = 'description';
      details.textContent = `${number(count.mentions)} ссылок · ${number(count.sources)} сайтов`;
      const form = document.createElement('form'); form.className = 'voice-reach-form'; form.dataset.query = group.query;
      const saved = reach[scope(group.query)] || {};
      for (const [name, caption] of [['total', 'Общий охват · люди'], ['target', 'Целевой охват · люди']]) {
        const label = document.createElement('label'); label.textContent = caption;
        const input = document.createElement('input'); input.type = 'number'; input.name = name;
        input.min = '0'; input.max = '1000000000000'; input.step = '1'; input.placeholder = 'Нет данных';
        if (saved[name] !== undefined) input.value = saved[name];
        label.append(input); form.append(label);
      }
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'button secondary'; save.textContent = 'Сохранить охват';
      const message = document.createElement('span'); message.className = 'voice-message'; message.setAttribute('role', 'status');
      message.textContent = saved.total !== undefined || saved.target !== undefined ? 'Введено вручную · сохранено в этом браузере' : 'Охват не измерен';
      form.append(save, message);
      card.append(heading, track, details, form); container.append(card);
    }
  }
  async function refresh() {
    const from = $('#voiceFrom').value, to = $('#voiceTo').value;
    if (from && to && from > to) { $('#voiceStatus').textContent = 'Дата начала позже даты окончания.'; return; }
    const id = ++requestNumber;
    $('#voiceStatus').textContent = 'Считаем упоминания…';
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const get = async url => {
        const response = await fetch(url, { headers: headers() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось загрузить аналитику.');
        return data.groups;
      };
      const [all, current] = await Promise.all([get('/api/analytics/voice'), get(`/api/analytics/voice?${params}`)]);
      if (id !== requestNumber) return;
      available = all; groups = current;
      render();
    } catch (error) { if (id === requestNumber) $('#voiceStatus').textContent = error.message; }
  }
  $('#voiceChoices').addEventListener('change', event => {
    if (event.target.type !== 'checkbox') return;
    if (event.target.checked) selected.add(event.target.value);
    else selected.delete(event.target.value);
    localStorage.setItem(selectionKey, JSON.stringify([...selected]));
    render();
  });
  $('#voiceRows').addEventListener('submit', event => {
    const form = event.target.closest('.voice-reach-form');
    if (!form) return;
    event.preventDefault();
    const total = form.elements.total.value, target = form.elements.target.value;
    if ([total, target].some(value => value !== '' && (!Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > 1e12))
        || (target !== '' && total === '')
        || (total !== '' && target !== '' && Number(target) > Number(total))) {
      form.querySelector('.voice-message').textContent = 'Укажите общий охват целым числом; целевой не должен превышать общий.';
      return;
    }
    const key = scope(form.dataset.query);
    if (total === '' && target === '') delete reach[key];
    else reach[key] = { ...(total === '' ? {} : { total: Number(total) }), ...(target === '' ? {} : { target: Number(target) }) };
    localStorage.setItem(reachKey, JSON.stringify(reach));
    form.querySelector('.voice-message').textContent = total === '' && target === '' ? 'Охват не измерен' : 'Введено вручную · сохранено в этом браузере';
  });
  $('#voiceRefresh').addEventListener('click', refresh);
  $('#voiceFrom').addEventListener('change', refresh);
  $('#voiceTo').addEventListener('change', refresh);
  document.querySelector('[data-tab="voice"]').addEventListener('click', refresh);
}());
