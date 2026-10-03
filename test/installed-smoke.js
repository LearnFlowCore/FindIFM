// Проверка запущенного установленного приложения через порт CDP.
const puppeteer = require('puppeteer-core');

async function main() {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:59341' });
  try {
    const pages = await browser.pages();
    const page = pages.find(item => /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url()));
    if (!page) throw new Error('Окно приложения не открыто');
    await page.waitForSelector('#keywordMonitor', { timeout: 15000 });
    const initial = await page.evaluate(() => ({
      title: document.title, monitor: document.querySelector('#keywordMonitor h3')?.textContent,
      deepPages: document.querySelector('[name="deepPages"]')?.value,
      error: document.querySelector('#toasts')?.textContent,
      status: document.querySelector('#apiText')?.textContent,
      launchDisabled: document.querySelector('#launchButton')?.disabled,
      monitorState: document.querySelector('#monitorState')?.textContent,
      quickTest: document.querySelector('#quickTestButton')?.textContent,
      preview: document.querySelector('#previewSort')?.options.length,
    }));
    console.log('Окно приложения:', JSON.stringify(initial));
    if (!initial.monitor || !initial.deepPages || !initial.quickTest || !initial.preview) throw new Error('Мониторинг, быстрый тест или предпросмотр не загрузились');
    if (process.argv.includes('--layout')) {
      await page.setViewport({ width: 1360, height: 860 });
      await page.click('[data-tab="results"]');
      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        sidebar: document.querySelector('.sidebar').getBoundingClientRect().width,
        results: document.querySelector('#resultsView').getBoundingClientRect().width,
        visible: document.querySelector('#resultsView').classList.contains('active'),
      }));
      console.log('Размеры интерфейса:', layout);
      if (!layout.visible || layout.sidebar > 200 || layout.results < layout.sidebar * 3) throw new Error('Раздел результатов не получил достаточно места');
      return;
    }

    await page.evaluate(() => {
      document.querySelector('[name="query"]').value = 'Википедия';
      document.querySelector('[name="deepPages"]').value = '1';
      document.querySelector('#quickTestButton').click();
    });
    await new Promise(resolve => setTimeout(resolve, 3500));
    console.log('После запуска:', await page.evaluate(() => ({
      monitor: document.querySelector('#monitorState')?.textContent,
      query: document.querySelector('#monitorQuery')?.textContent,
      message: document.querySelector('#monitorCurrent')?.textContent,
      toasts: document.querySelector('#toasts')?.textContent,
      summary: document.querySelector('#resultsSummary')?.textContent,
    })));
    await page.waitForFunction(() => document.querySelector('#monitorQuery')?.textContent === 'Википедия', { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#stopSearchButton') && !document.querySelector('#stopSearchButton').hidden || ['Завершено', 'Ошибка'].includes(document.querySelector('#monitorState')?.textContent), { timeout: 90000 });
    const stopVisible = await page.$eval('#stopSearchButton', button => !button.hidden);
    if (stopVisible) {
      await page.click('#stopSearchButton');
      await page.waitForFunction(() => ['Остановлено', 'Завершено'].includes(document.querySelector('#monitorState')?.textContent), { timeout: 60000 });
    }
    const result = await page.evaluate(() => ({
      state: document.querySelector('#monitorState')?.textContent,
      checked: document.querySelector('#monitorChecked')?.textContent,
      found: document.querySelector('#monitorFound')?.textContent,
      query: document.querySelector('#monitorQuery')?.textContent,
      events: document.querySelectorAll('.monitor-event').length,
      errors: document.querySelector('#monitorErrors')?.textContent,
      eta: document.querySelector('#monitorEta')?.textContent,
      percent: document.querySelector('#monitorPercent')?.textContent,
      preview: Boolean(document.querySelector('#previewBody')),
      messages: document.querySelector('#toasts')?.textContent,
    }));
    console.log('Установленное приложение:', JSON.stringify(result));
    if (!['Завершено', 'Остановлено'].includes(result.state) || result.query !== 'Википедия' || !result.preview || !result.percent || !result.eta) {
      throw new Error('Быстрый тест, остановка или элементы мониторинга не прошли проверку');
    }
  } finally { await browser.disconnect(); }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
