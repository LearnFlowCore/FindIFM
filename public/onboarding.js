(function () {
  'use strict';
  const intro = document.querySelector('#searchView .section-intro');
  if (!intro) return;
  const guide = document.createElement('details');
  guide.id = 'quickStart';
  guide.className = 'quick-start';
  guide.innerHTML = '<summary>Как начать · 3 шага</summary><ol><li><strong>Введите бренд или тему</strong> и запустите поиск.</li><li><strong>Следите за результатами</strong> — новые ссылки появляются во время проверки.</li><li><strong>Оцените тональность</strong> и откройте публикации для проверки контекста.</li></ol>';
  intro.after(guide);
  guide.open = localStorage.getItem('signal-quick-start-seen') !== '1';
  guide.addEventListener('toggle', () => {
    if (!guide.open) localStorage.setItem('signal-quick-start-seen', '1');
  });
  window.addEventListener('signal-job-selected', () => {
    guide.open = false;
    localStorage.setItem('signal-quick-start-seen', '1');
  });
}());
