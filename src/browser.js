// Управление установленным Яндекс Браузером через CDP и puppeteer-core.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (base, jitter) => Math.max(0, base + Math.round((Math.random() * 2 - 1) * jitter));

function applySearchParams(url, query, pageNumber) {
  const target = new URL(url, 'https://yandex.ru');
  if (!/(^|\.)(yandex\.ru|dzen\.ru)$/i.test(target.hostname)) throw new Error('Вкладка «Новости» ведёт за пределы Яндекса и Дзена.');
  target.searchParams.set('text', query.yandexText);
  target.searchParams.set('p', String(pageNumber));
  if (/(^|\.)dzen\.ru$/i.test(target.hostname)) {
    target.searchParams.set('query', query.yandexText);
    target.searchParams.set('type_filter', 'news');
  }
  if (query.within) target.searchParams.set('within', query.within); else target.searchParams.delete('within');
  if (query.from && query.to) target.searchParams.set('date', `${query.from.replaceAll('-', '')}-${query.to.replaceAll('-', '')}`);
  else target.searchParams.delete('date');
  return target.toString();
}

class CaptchaError extends Error { constructor(message = 'Яндекс запросил капчу') { super(message); this.name = 'CaptchaError'; } }

class YandexBrowser {
  constructor(config, logger, dataRoot) {
    this.config = config; this.log = logger; this.dataRoot = dataRoot;
    this.temporaryProfile = this.newTemporaryProfile();
    this.browser = null; this.signature = null;
  }
  newTemporaryProfile() {
    return path.join(this.dataRoot, 'data', `browser-profile-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  }
  async open(settings) {
    const executablePath = settings.browserPath || this.config.browserExecutable;
    if (!fs.existsSync(executablePath)) throw new Error(`Яндекс Браузер не найден: ${executablePath}`);
    const usesUserProfile = settings.profileType === 'user' && settings.profilePath;
    const userDataDir = usesUserProfile ? settings.profilePath : this.temporaryProfile;
    const signature = `${executablePath}|${userDataDir}`;
    if (this.browser && this.signature !== signature) await this.close();
    if (this.browser?.connected) return this.browser;
    fs.mkdirSync(userDataDir, { recursive: true });
    try {
      this.browser = await puppeteer.launch({
        executablePath, headless: false, userDataDir, defaultViewport: null,
        args: ['--no-first-run'],
      });
    } catch (error) {
      // A disconnected Yandex process can leave the temporary profile locked.
      // Never reuse that lock for the next search; user profiles are not rotated.
      if (usesUserProfile || !/browser is already running|profile.*lock/i.test(error.message || '')) throw error;
      this.temporaryProfile = this.newTemporaryProfile();
      this.log.warn?.({ error: error.message }, 'Временный профиль Яндекса занят, запускаем новый');
      return this.open(settings);
    }
    this.signature = signature;
    this.browser.once('disconnected', () => { this.browser = null; this.signature = null; });
    return this.browser;
  }
  searchUrl(query, pageNumber = 0) {
    return applySearchParams('https://yandex.ru/search/', query, pageNumber);
  }
  async evaluate(page, callback, ...args) {
    let lastError;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { return await page.evaluate(callback, ...args); }
      catch (error) {
        lastError = error;
        if (page.isClosed() || !/execution context|detached frame|cannot find context/i.test(error.message || '')) throw error;
        await sleep(500);
      }
    }
    throw lastError;
  }
  async newsTabUrl(page) {
    const href = await this.evaluate(page, () => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU');
      const links = [...document.querySelectorAll('a[href]')];
      const isNewsTarget = link => {
        try {
          const target = new URL(link.href, location.href);
          return /(^|\.)(yandex\.ru|dzen\.ru)$/i.test(target.hostname)
            && (/news/i.test(target.pathname) || target.searchParams.get('type') === 'news');
        } catch { return false; }
      };
      const tab = links.find(link => normalize(link.textContent) === 'новости' && isNewsTarget(link))
        || links.find(link => normalize(link.textContent).includes('новости') && isNewsTarget(link));
      return tab?.href || '';
    });
    // В текущем интерфейсе Яндекса вкладка может быть скрыта; официальный URL
    // перенаправляет на актуальную новостную вкладку Дзена.
    return href || 'https://yandex.ru/news/search';
  }
  async isCaptcha(page) {
    const state = await this.evaluate(page, () => ({
      url: location.href, title: document.title,
      captcha: Boolean(document.querySelector('[class*="Captcha"],[class*="captcha"],iframe[src*="captcha"],form[action*="captcha"]')),
    }));
    return state.captcha || /captcha|showcaptcha|подтвердите/i.test(`${state.url} ${state.title}`);
  }
  async waitForResults(page, settings, onCaptcha) {
    await sleep(2500);
    if (!(await this.isCaptcha(page))) return true;
    onCaptcha?.();
    if (settings.captchaStrategy === 'skip') return false;
    while (page && !page.isClosed() && await this.isCaptcha(page)) await sleep(2000);
    return true;
  }
  async waitForNewsCards(page) {
    try {
      await page.waitForSelector('a.news-link-new_primary[href],a[class*="InstoryList__title"][href],a[href*="/news/story/"]', { timeout: 15000 });
      return true;
    } catch (error) {
      if (page.isClosed()) return false;
      this.log.warn?.({ error: error.message }, 'Новостные карточки не появились до тайм-аута, продолжаем без падения задания');
      return true;
    }
  }
  async navigate(page, url, timeout = 20000) {
    try {
      // Яндекс держит сетевые соединения открытыми, поэтому ожидание полного
      // DOM-события часто превышает таймаут, хотя выдача уже отрисована.
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (error) {
      if (!/timeout/i.test(error.message || '') || page.isClosed()) throw error;
      this.log.warn({ url, error: error.message }, 'Навигация превысила тайм-аут, проверяем уже загруженную выдачу');
      return null;
    }
  }
  async collect(query, settings, onCaptcha) {
    const browser = await this.open(settings);
    const page = await browser.newPage();
    const collected = [];
    try {
      const initialResponse = await this.navigate(page, this.searchUrl(query));
      if (initialResponse?.status() === 429) { await sleep(60000); throw new CaptchaError('Яндекс вернул HTTP 429'); }
      if (!(await this.waitForResults(page, settings, onCaptcha))) return collected;
      const newsTab = await this.newsTabUrl(page);

      for (let number = 0; number < settings.maxPages; number += 1) {
        const url = applySearchParams(newsTab, query, number);
        const response = await this.navigate(page, url);
        if (response?.status() === 429) { await sleep(60000); throw new CaptchaError('Яндекс вернул HTTP 429'); }
        if (!(await this.waitForResults(page, settings, onCaptcha))) break;
        if (!(await this.waitForNewsCards(page))) break;
        let rows;
        try {
          rows = await this.evaluate(page, () => {
          const storyLinks = [...document.querySelectorAll('a.news-link-new_primary[href],a[class*="InstoryList__title"][href],a[href*="/news/story/"]')];
          if (storyLinks.length) {
            return storyLinks.map(link => {
              const node = link.closest('.news-search-content__block,[class*="InstoryList__content"]') || link.parentElement;
              const date = node.querySelector('time,[class*="date"],[class*="time"]');
               return {
                 title: link.textContent.trim(), url: link.href,
                 snippet: node.textContent.trim().slice(0, 2000),
                 dateText: date?.textContent.trim() || '', searchType: 'news',
               };
            });
          }
          const selectors = [
            'article.news-search-story', '.news-search-story', 'li.serp-item',
            '.Organic', '[data-cid][class*="news"]', '[class*="NewsSearch"] article',
          ];
          const nodes = [...new Set(document.querySelectorAll(selectors.join(',')))];
          return nodes.map(node => {
            const link = node.querySelector('a[href][class*="title"],h2 a[href],h3 a[href],a.OrganicTitle-Link');
            const snippet = node.querySelector('[class*="snippet"],[class*="text"],.OrganicTextContentSpan');
            const date = node.querySelector('time,[class*="date"],[class*="time"]');
            return link ? {
              title: link.textContent.trim(), url: link.href,
              snippet: snippet?.textContent.trim() || '', dateText: date?.textContent.trim() || '',
              searchType: 'news',
            } : null;
          }).filter(Boolean);
          });
        } catch (error) {
          if (page.isClosed() || /execution context|detached frame|cannot find context/i.test(error.message || '')) {
            this.log.warn?.({ error: error.message }, 'Страница выдачи изменилась во время чтения, пропускаем её');
            break;
          }
          throw error;
        }
        collected.push(...rows);
        if (!rows.length) break;
        await sleep(randomDelay(settings.pageDelay, settings.pageJitter));
      }
      return collected;
    } finally {
      if (!page.isClosed()) {
        try { await page.close(); } catch (error) { this.log.debug({ error: error.message }, 'Страница уже закрыта браузером'); }
      }
    }
  }
  async inspect(url, query, settings) {
    const browser = await this.open(settings);
    let lastError;
    for (const delay of [0, 1000, 2000, 4000]) {
      if (delay) await sleep(delay);
      const page = await browser.newPage();
      try {
        await sleep(randomDelay(settings.resultDelay, settings.resultJitter));
        const response = await this.navigate(page, url, 15000);
        if (response?.status() >= 500) throw new Error(`HTTP ${response.status()}`);
        if (/(^|\.)dzen\.ru$/i.test(new URL(url).hostname)) {
          try {
            await page.waitForSelector('a.news-story-block__link[href],a[class*="StoryHead"][href],a[class*="StorySourceLink"][href]', { timeout: 8000 });
          } catch (error) {
            if (!/timeout/i.test(error.message || '') || page.isClosed()) throw error;
          }
        }
        return await this.evaluate(page, words => {
          const meta = selector => document.querySelector(selector)?.content || '';
          const title = meta('meta[property="og:title"]') || document.title;
          const date = meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || document.querySelector('time[datetime]')?.dateTime || document.querySelector('time')?.textContent || '';
          const candidates = [...document.querySelectorAll('p')].map(item => item.textContent.trim()).filter(item => item.length > 40);
          const description = candidates.find(item => words.some(word => item.toLocaleLowerCase('ru-RU').includes(word))) || meta('meta[name="description"]') || candidates[0] || '';
          const sourceSelectors = 'a.news-story-block__link[href],a[class*="StoryHead"][href],a[class*="StorySourceLink"][href]';
          const seen = new Set();
          const sources = [...document.querySelectorAll(sourceSelectors)].map(link => {
            try {
              const url = new URL(link.href, location.href);
              if (!/^https?:$/.test(url.protocol) || /(^|\.)(dzen\.ru|yandex\.(ru|com))$/i.test(url.hostname)) return null;
              url.hash = '';
              const key = url.toString();
              if (seen.has(key)) return null;
              seen.add(key);
              return { url: key, label: link.textContent.trim() };
            } catch { return null; }
          }).filter(Boolean);
          return { title, dateText: date, description: description.slice(0, 300), text: document.body?.innerText || '', sources };
        }, query.words);
      } catch (error) { lastError = error; }
      finally {
        if (!page.isClosed()) {
          try { await page.close(); } catch (error) { this.log.debug({ error: error.message }, 'Страница уже закрыта браузером'); }
        }
      }
    }
    throw lastError;
  }
  async userAgent(settings) { const browser = await this.open(settings); return browser.userAgent(); }
  async close() { const active = this.browser; this.browser = null; this.signature = null; if (active?.connected) await active.close(); }
}
module.exports = { YandexBrowser, CaptchaError, sleep, randomDelay, applySearchParams };
