// Управление установленным Яндекс Браузером через CDP и puppeteer-core.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (base, jitter) => Math.max(0, base + Math.round((Math.random() * 2 - 1) * jitter));

function applySearchParams(url, query, pageNumber) {
  const target = new URL(url, 'https://yandex.ru');
  if (!/(^|\.)yandex\.ru$/i.test(target.hostname) || target.pathname !== '/search/') throw new Error('Ожидается адрес общего поиска Яндекса.');
  target.searchParams.delete('type');
  target.searchParams.set('text', query.yandexText);
  target.searchParams.set('p', String(pageNumber));
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
    this.browser = null; this.signature = null; this.captchaPage = null;
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
        executablePath, headless: process.platform === 'linux', userDataDir, defaultViewport: null,
        args: ['--no-first-run', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])],
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
  async isCaptcha(page) {
    const state = await this.evaluate(page, () => ({
      url: location.href, title: document.title,
      captcha: Boolean(document.querySelector('[class*="Captcha"],[class*="captcha"],iframe[src*="captcha"],form[action*="captcha"]')),
    }));
    return state.captcha || /captcha|showcaptcha|подтвердите/i.test(`${state.url} ${state.title}`);
  }
  async waitForResults(page, settings, onCaptcha, hooks = {}) {
    await sleep(2500);
    if (!(await this.isCaptcha(page))) return true;
    onCaptcha?.();
    if (settings.captchaStrategy === 'skip') throw new CaptchaError('Яндекс запросил CAPTCHA; поиск остановлен.');
    if (settings.captchaStrategy === 'manual') this.captchaPage = page;
    const expiresAt = Date.now() + 15 * 60000;
    try {
      while (page && !page.isClosed()) {
        if (hooks.isCancelled?.()) throw new Error('Поиск остановлен пользователем');
        if (Date.now() >= expiresAt) throw new CaptchaError('Время ручного подтверждения CAPTCHA истекло (15 минут).');
        await sleep(2000);
        if (!(await this.isCaptcha(page))) { hooks.onCaptchaSolved?.(); return true; }
      }
      throw new CaptchaError('Окно CAPTCHA закрыто до подтверждения.');
    } finally { if (this.captchaPage === page) this.captchaPage = null; }
  }
  async captchaScreenshot() {
    const page = this.captchaPage;
    if (!page || page.isClosed()) throw new Error('Окно CAPTCHA уже недоступно.');
    const image = await page.screenshot({ type: 'jpeg', quality: 70 });
    return { image: `data:image/jpeg;base64,${image.toString('base64')}`, width: page.viewport().width, height: page.viewport().height };
  }
  async captchaAction(action) {
    const page = this.captchaPage;
    if (!page || page.isClosed()) throw new Error('Окно CAPTCHA уже недоступно.');
    const { type, x, y, value } = action;
    if (['move', 'down', 'up', 'click', 'scroll'].includes(type)) {
      const { width, height } = page.viewport();
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) throw new Error('Некорректные координаты.');
      await page.mouse.move(x, y);
      if (type === 'down') await page.mouse.down();
      if (type === 'up') await page.mouse.up();
      if (type === 'click') await page.mouse.click(x, y);
      if (type === 'scroll') await page.mouse.wheel({ deltaY: Math.max(-600, Math.min(600, Number(value) || 0)) });
    } else if (type === 'text' && typeof value === 'string' && value.length <= 200) await page.keyboard.type(value);
    else if (type === 'key' && ['Enter', 'Tab', 'Backspace', 'Escape', 'Space'].includes(value)) await page.keyboard.press(value);
    else throw new Error('Недопустимое действие для CAPTCHA.');
  }
  async waitForSearchCards(page) {
    try {
      await page.waitForSelector('li.serp-item,.Organic,[data-cid],.OrganicTitle-Link[href],[class*="OrganicTitle"] a[href],h2 a[href]', { timeout: 15000 });
      return true;
    } catch (error) {
      if (page.isClosed()) return false;
      this.log.warn?.({ url: page.url?.(), error: error.message }, 'Карточки веб-поиска не появились до тайм-аута');
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
  async collect(query, settings, hooks = {}) {
    if (typeof hooks === 'function') hooks = { onCaptcha: hooks };
    const browser = await this.open(settings);
    const page = await browser.newPage();
    if (process.platform === 'linux') await page.setViewport({ width: 1000, height: 720 });
    const collected = [];
    const deadline = Date.now() + Math.max(1, Number(settings.maxDurationMinutes) || 30) * 60000;
    try {
      for (let number = 0; number < settings.maxPages; number += 1) {
        if (hooks.isCancelled?.()) break;
        if (Date.now() >= deadline) { this.log.warn?.({ page: number }, 'Достигнут лимит времени поисковой задачи'); break; }
        const url = this.searchUrl(query, number);
        const response = await this.navigate(page, url);
        if (response?.status() === 429) throw new CaptchaError('Яндекс вернул HTTP 429');
        if (response?.status() >= 400) throw new Error(`Яндекс вернул HTTP ${response.status()}`);
        if (!(await this.waitForResults(page, settings, hooks.onCaptcha, hooks))) break;
        if (!(await this.waitForSearchCards(page))) break;
        let rows;
        try {
          rows = await this.evaluate(page, () => {
            const nodes = [...new Set(document.querySelectorAll('li.serp-item,.Organic,[data-cid][class*="organic"],article[class*="Organic"]'))];
            return nodes.map(node => {
              const link = node.querySelector('h2 a[href],h3 a[href],a.OrganicTitle-Link[href],[class*="OrganicTitle"] a[href]');
              const snippet = node.querySelector('[class*="snippet"],[class*="Snippet"],.OrganicTextContentSpan');
              const date = node.querySelector('time,[class*="date"],[class*="Date"]');
              return link ? {
                title: link.textContent.trim(), url: link.href,
                snippet: snippet?.textContent.trim() || node.textContent.trim().slice(0, 2000),
                dateText: date?.getAttribute('datetime') || date?.textContent.trim() || '', searchType: 'web',
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
        if (!rows.length && number === 0) {
          const state = await this.evaluate(page, () => ({ title: document.title, body: document.body?.innerText?.slice(0, 400) || '', url: location.href }));
          if (!/ничего не нашлось|ничего не найдено|по вашему запросу ничего/i.test(state.body)) {
            throw new Error(`Не удалось распознать веб-выдачу Яндекса: ${state.url} (${state.title})`);
          }
        }
        collected.push(...rows);
        hooks.onCheckpoint?.(number + 1, collected.length);
        if (collected.length >= (Number(settings.maxResults) || 500)) break;
        if (!rows.length) break;
        await sleep(randomDelay(settings.pageDelay, settings.pageJitter));
      }
      return collected;
    } finally {
      if (this.captchaPage === page) this.captchaPage = null;
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
        if (response?.status() >= 400) throw new Error(`HTTP ${response.status()}`);
        return await this.evaluate(page, words => {
          const meta = selector => document.querySelector(selector)?.content || '';
          const title = meta('meta[property="og:title"]') || document.title;
          const date = meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || document.querySelector('time[datetime]')?.dateTime || document.querySelector('time')?.textContent || '';
          const contentRoot = document.querySelector('article,main,[role="main"]') || document.body;
          const candidates = [...(contentRoot?.querySelectorAll('p') || [])].map(item => item.textContent.trim()).filter(item => item.length > 40);
          const description = candidates.find(item => words.some(word => item.toLocaleLowerCase('ru-RU').includes(word))) || meta('meta[name="description"]') || candidates[0] || '';
          const text = contentRoot?.innerText || '';
          const links = [...(contentRoot?.querySelectorAll('a[href]') || [])].slice(0, 300)
            .map(link => link.href).filter(Boolean);
          return {
            title, dateText: date, description: description.slice(0, 2000), text,
            textLength: text.length, category: meta('meta[property="article:section"]') || meta('meta[name="category"]'),
            hasMedia: Boolean(document.querySelector('main img,article img,main video,article video,video')),
            links,
          };
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
  async close() { const active = this.browser; this.browser = null; this.signature = null; this.captchaPage = null; if (active?.connected) await active.close(); }
}
module.exports = { YandexBrowser, CaptchaError, sleep, randomDelay, applySearchParams };
