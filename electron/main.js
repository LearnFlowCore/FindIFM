// Главное окружение desktop-приложения владеет окном, backend и завершением процессов.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Notification, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startServer } = require('../src/server');

app.setName('Сигнал');
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

let mainWindow = null;
let service = null;
let shutdownPromise = null;
let developmentWatchers = [];
let reloadTimer = null;
let updateTimer = null;
const appIcon = path.resolve(__dirname, '..', 'build', 'icon.ico');

function openExternal(url) {
  try {
    const target = new URL(url);
    if (['http:', 'https:'].includes(target.protocol)) shell.openExternal(target.toString());
  } catch {}
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', info => {
    console.log(`Доступно обновление ${info.version}, загрузка началась`);
    if (Notification.isSupported()) new Notification({ title: 'Сигнал', body: `Доступно обновление ${info.version}. Оно будет установлено после перезапуска.` }).show();
  });
  autoUpdater.on('update-downloaded', info => {
    const notification = Notification.isSupported()
      ? new Notification({ title: 'Сигнал', body: `Обновление ${info.version} загружено. Перезапустите приложение для установки.` })
      : null;
    notification?.on('click', () => autoUpdater.quitAndInstall());
  });
  autoUpdater.on('error', error => console.error('Ошибка автообновления:', error.message));
  const check = () => autoUpdater.checkForUpdates().catch(error => console.error('Проверка обновлений не выполнена:', error.message));
  setTimeout(check, 10000);
  updateTimer = setInterval(check, 6 * 60 * 60 * 1000);
}

async function createApplication() {
  const token = crypto.randomBytes(32).toString('hex');
  service = await startServer({
    dataRoot: app.getPath('userData'),
    host: '127.0.0.1',
    port: 0,
    token,
    notify: (message, event) => {
      if (Notification.isSupported()) {
        const notification = new Notification({ title: event === 'captcha' ? 'Сигнал · Пройдите CAPTCHA' : 'Сигнал', body: message, icon: appIcon });
        if (event === 'captcha') notification.on('click', () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        });
        notification.show();
      }
    },
  });

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fb',
    icon: appIcon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === service.url) return; } catch {}
    event.preventDefault();
    openExternal(url);
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(`${service.url}/#token=${encodeURIComponent(token)}`);
  setupAutoUpdater();
  startDevelopmentWatcher();
}

function startDevelopmentWatcher() {
  if (app.isPackaged || developmentWatchers.length) return;
  const root = path.resolve(__dirname, '..');
  for (const folder of ['electron', 'src', 'public']) {
    const target = path.join(root, folder);
    if (!fs.existsSync(target)) continue;
    developmentWatchers.push(fs.watch(target, { recursive: true }, (_event, filename) => {
      if (!filename || reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        app.relaunch();
        app.exit(0);
      }, 500);
    }));
  }
}

async function shutdown() {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      mainWindow?.hide();
      if (service) await service.stop();
       service = null;
       if (updateTimer) clearInterval(updateTimer);
       updateTimer = null;
      developmentWatchers.forEach(watcher => watcher.close());
      developmentWatchers = [];
    })();
  }
  return shutdownPromise;
}

if (hasLock) {
  app.setAppUserModelId('ru.local.mentionmonitor');
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createApplication).catch(error => {
    console.error(error);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!service || shutdownPromise) return;
    event.preventDefault();
    shutdown().finally(() => app.quit());
  });
}
