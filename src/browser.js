// Управление установленным Яндекс Браузером через CDP и puppeteer-core.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (base, jitter) => Math.max(0, base + Math.round((Math.random() * 2 - 1) * jitter));

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseDuckDuckGoResults(html) {
  const rows = [];
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html || '')))) {
    const parsedHref = decodeHtml(match[1]);
    let url;
    try {
      const link = new URL(parsedHref, 'https://html.duckduckgo.com');
      url = link.searchParams.get('uddg') || link.toString();
    } catch { continue; }
    if (!/^https?:\/\//i.test(url) || /(^|\.)duckduckgo\.com$/i.test(new URL(url).hostname)) continue;
    const start = match.index + match[0].length;
    const tail = String(html).slice(start, start + 2500);
    const snippetMatch = tail.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a|class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div/i);
    rows.push({ title: decodeHtml(match[2].replace(/<[^>]+>/g, '')), url, snippet: decodeHtml((snippetMatch?.[1] || snippetMatch?.[2] || '').replace(/<[^>]+>/g, '').trim()), dateText: '', searchType: 'fallback' });
  }
  return rows;
}

function parseBingResults(xml) {
  const rows = [];
  for (const item of String(xml || '').match(/<item>[\s\S]*?<\/item>/gi) || []) {
    const value = name => item.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '';
    const url = decodeHtml(value('link').replace(/<!\[CDATA\[|\]\]>/g, '').trim()).replace(/^http:\/\//i, 'https://');
    if (!/^https?:\/\//i.test(url)) continue;
    rows.push({
      title: decodeHtml(value('title').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim()),
      url,
      snippet: decodeHtml(value('description').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim()),
      dateText: '', searchType: 'fallback',
    });
  }
  return rows;
}

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
  async waitForResults(page, settings, onCaptcha) {
    await sleep(2500);
    if (!(await this.isCaptcha(page))) return true;
    onCaptcha?.();
    if (settings.captchaStrategy === 'skip') return false;
    while (page && !page.isClosed() && await this.isCaptcha(page)) await sleep(2000);
    return true;
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
    const collected = [];
    let captchaDetected = false;
    const deadline = Date.now() + Math.max(1, Number(settings.maxDurationMinutes) || 30) * 60000;
    try {
      for (let number = 0; number < settings.maxPages; number += 1) {
        if (hooks.isCancelled?.()) break;
        if (Date.now() >= deadline) { this.log.warn?.({ page: number }, 'Достигнут лимит времени поисковой задачи'); break; }
        const url = this.searchUrl(query, number);
        const response = await this.navigate(page, url);
        if (response?.status() === 429) throw new CaptchaError('Яндекс вернул HTTP 429');
        if (response?.status() >= 400) throw new Error(`Яндекс вернул HTTP ${response.status()}`);
        if (!(await this.waitForResults(page, settings, () => { captchaDetected = true; hooks.onCaptcha?.(); }))) break;
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
      if (!collected.length && captchaDetected && settings.captchaStrategy === 'skip') {
        this.log.warn?.('Яндекс запросил CAPTCHA, используем резервную веб-выдачу');
        return this.collectDuckDuckGo(query, settings, hooks);
      }
      return collected;
    } finally {
      if (!page.isClosed()) {
        try { await page.close(); } catch (error) { this.log.debug({ error: error.message }, 'Страница уже закрыта браузером'); }
      }
    }
  }
  async collectDuckDuckGo(query, settings, hooks = {}) {
    const collected = [];
    const deadline = Date.now() + Math.max(1, Number(settings.maxDurationMinutes) || 30) * 60000;
    const pages = Math.min(Number(settings.maxPages) || 1, 3);
    for (let number = 0; number < pages && Date.now() < deadline; number += 1) {
      const text = query.yandexText || query.text || query.original;
      const bingUrl = new URL('https://www.bing.com/search');
      bingUrl.searchParams.set('format', 'rss');
      bingUrl.searchParams.set('q', text);
      const response = await fetch(bingUrl);
      if (!response.ok) throw new Error(`Резервная выдача вернула HTTP ${response.status}`);
      let rows = parseBingResults(await response.text());
      if (!rows.length) {
        const duckUrl = new URL('https://html.duckduckgo.com/html/');
        duckUrl.searchParams.set('q', text);
        if (number) duckUrl.searchParams.set('s', String(number * 30));
        const duckResponse = await fetch(duckUrl);
        if (!duckResponse.ok) throw new Error(`Резервная выдача вернула HTTP ${duckResponse.status}`);
        rows = parseDuckDuckGoResults(await duckResponse.text());
      }
      collected.push(...rows);
      hooks.onCheckpoint?.(number + 1, collected.length);
      if (!rows.length) break;
      await sleep(randomDelay(settings.pageDelay, settings.pageJitter));
    }
    return collected;
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
  async close() { const active = this.browser; this.browser = null; this.signature = null; if (active?.connected) await active.close(); }
}
module.exports = { YandexBrowser, CaptchaError, sleep, randomDelay, applySearchParams, parseDuckDuckGoResults, parseBingResults };
