// Главное окружение desktop-приложения владеет окном, backend и завершением процессов.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Notification, shell } = require('electron');
const { startServer } = require('../src/server');

app.setName('Mention Monitor');
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

let mainWindow = null;
let service = null;
let shutdownPromise = null;
let developmentWatchers = [];
let reloadTimer = null;

function openExternal(url) {
  try {
    const target = new URL(url);
    if (['http:', 'https:'].includes(target.protocol)) shell.openExternal(target.toString());
  } catch {}
}

async function createApplication() {
  const token = crypto.randomBytes(32).toString('hex');
  service = await startServer({
    dataRoot: app.getPath('userData'),
    host: '127.0.0.1',
    port: 0,
    token,
    notify: message => {
      if (Notification.isSupported()) new Notification({ title: 'Монитор упоминаний', body: message }).show();
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
