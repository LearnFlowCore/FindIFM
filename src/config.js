// Неизменяемые ресурсы и пользовательские данные имеют разные корневые папки.
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function findYandexBrowser() {
  const candidates = [
    process.env.YANDEX_BROWSER_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0] || '';
}

function createConfig(overrides = {}) {
  const dataRoot = path.resolve(overrides.dataRoot || process.env.DATA_ROOT || projectRoot);
  const port = overrides.port ?? Number(process.env.PORT || 3080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Некорректный порт приложения.');
  return {
    projectRoot,
    dataRoot,
    host: overrides.host || process.env.HOST || '127.0.0.1',
    port,
    dbPath: overrides.dbPath || process.env.DB_PATH || path.join(dataRoot, 'data', 'mention-monitor.db'),
    browserExecutable: overrides.browserExecutable || findYandexBrowser(),
    requestLimit: '1mb',
  };
}

module.exports = { ...createConfig(), createConfig, findYandexBrowser };
