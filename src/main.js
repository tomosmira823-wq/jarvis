const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');
const { Agent } = require('./agent');
const { listenOnce } = require('./voice');
const { McpManager } = require('./mcp');
const attachments = require('./attachments');

log.initialize();
autoUpdater.logger = log;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userDir = app.getPath('userData');
const settingsPath = path.join(userDir, 'settings.json');
const memoryPath = path.join(userDir, 'memory.json');

const DEFAULTS = {
  apiKeyEnc: '',
  model: 'claude-sonnet-5-5',
  callMe: 'sir',
  speak: true,
  voiceName: '',
  hotkey: 'Control+Shift+Space',
  askBeforeActions: false,
  webSearch: true,
  launchAtStartup: false,
  startHidden: false,
  bootAnim: true,
};

let settings = loadSettings();
let win = null;
let tray = null;
let agent = null;
let mcp = null;
let quitting = false;
let updateReady = false;

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function getApiKey() {
  if (!settings.apiKeyEnc) return '';
  try {
    const buf = Buffer.from(settings.apiKeyEnc, 'base64');
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return '';
  }
}

function setApiKey(key) {
  key = (key || '').trim();
  if (!key) {
    settings.apiKeyEnc = '';
    return;
  }
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
  settings.apiKeyEnc = buf.toString('base64');
}

function encryptText(t) {
  return safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(t).toString('base64') : 'raw:' + t;
}

function decryptText(t) {
  if (t.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(t.slice(4), 'base64'));
  if (t.startsWith('raw:')) return t.slice(4);
  return t;
}

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  } catch {
    return [];
  }
}

function saveMemory(items) {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(memoryPath, JSON.stringify(items, null, 2));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function iconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 560,
    minHeight: 480,
    show: !(settings.startHidden || process.argv.includes('--hidden')),
    backgroundColor: '#02060a',
    title: 'Jarvis',
    icon: iconPath(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#5fdcff', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Links the model prints open in the real browser, not inside Jarvis.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    win.show();
    win.focus();
    send('focus-input');
  }
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Jarvis');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Jarvis', click: () => { win.show(); win.focus(); } },
      { label: 'Check for updates', click: () => checkForUpdates(true) },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on('click', toggleWindow);
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.hotkey) return true;
  try {
    return globalShortcut.register(settings.hotkey, toggleWindow);
  } catch {
    return false;
  }
}

function applyStartup() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup, args: ['--hidden'] });
}

// ---------- updates ----------
function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) send('update-status', { state: 'dev', message: 'Updates only work in the installed app.' });
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('update check failed', err);
    if (manual) send('update-status', { state: 'error', message: 'Update check failed: ' + err.message });
  });
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('checking-for-update', () => send('update-status', { state: 'checking' }));
autoUpdater.on('update-available', (info) => send('update-status', { state: 'downloading', version: info.version }));
autoUpdater.on('update-not-available', () => send('update-status', { state: 'latest', version: app.getVersion() }));
autoUpdater.on('download-progress', (p) => send('update-status', { state: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => {
  updateReady = true;
  send('update-status', { state: 'ready', version: info.version });
});
autoUpdater.on('error', (err) => send('update-status', { state: 'error', message: err == null ? 'unknown' : err.message }));

// ---------- agent ----------
const pendingApprovals = new Map();
let approvalSeq = 0;

function requestApproval(tool, input) {
  if (!settings.askBeforeActions) return Promise.resolve(true);
  const id = ++approvalSeq;
  if (win && !win.isVisible()) win.show();
  send('agent-event', { type: 'approval', id, tool, input });
  return new Promise((resolve) => pendingApprovals.set(id, resolve));
}

function buildAgent() {
  agent = new Agent({
    getApiKey,
    getSettings: () => settings,
    loadMemory,
    saveMemory,
    requestApproval,
    mcp,
    emit: (evt) => send('agent-event', evt),
    hideWindow: () => win && win.isVisible() && win.minimize(),
    restoreWindow: () => win && win.restore(),
  });
}

// ---------- live system readouts for the HUD ----------
const os = require('os');
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] || c;
    for (const k of Object.keys(c.times)) total += c.times[k] - p.times[k];
    idle += c.times.idle - p.times.idle;
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}
function diskInfo() {
  try {
    const s = fs.statfsSync(process.platform === 'win32' ? 'C:\\' : '/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, used: total - free };
  } catch {
    return null;
  }
}
function localIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '—';
}
ipcMain.handle('sys-stats', () => ({
  cpu: cpuPercent(),
  cpuName: (os.cpus()[0]?.model || '').replace(/\s+/g, ' ').trim(),
  cores: os.cpus().length,
  memTotal: os.totalmem(),
  memUsed: os.totalmem() - os.freemem(),
  disk: diskInfo(),
  uptime: os.uptime(),
  host: os.hostname(),
  user: os.userInfo().username,
  ip: localIp(),
  platform: `${os.type()} ${os.release()}`,
}));

// ---------- IPC ----------
ipcMain.handle('get-settings', () => {
  const { apiKeyEnc, ...rest } = settings;
  const key = getApiKey();
  return {
    ...rest,
    hasApiKey: !!key,
    apiKeyHint: key ? key.slice(0, 10) + '…' + key.slice(-4) : '',
    version: app.getVersion(),
    updateReady,
  };
});

ipcMain.handle('save-settings', (_e, incoming) => {
  const prevHotkey = settings.hotkey;
  if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) setApiKey(incoming.apiKey);
  if (incoming.clearApiKey) setApiKey('');
  for (const k of ['model', 'callMe', 'speak', 'voiceName', 'hotkey', 'askBeforeActions', 'webSearch', 'launchAtStartup', 'startHidden', 'bootAnim']) {
    if (k in incoming) settings[k] = incoming[k];
  }
  saveSettings();
  applyStartup();
  let hotkeyOk = true;
  if (settings.hotkey !== prevHotkey) hotkeyOk = registerHotkey();
  return { ok: true, hotkeyOk };
});

ipcMain.handle('test-key', async (_e, key) => {
  const Anthropic = require('@anthropic-ai/sdk').default;
  try {
    const client = new Anthropic({ apiKey: (key || getApiKey()).trim() });
    await client.messages.create({ model: settings.model, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('send-message', (_e, payload) =>
  typeof payload === 'string' ? agent.run(payload, []) : agent.run(payload.text, payload.attachments || [])
);

// ---------- attachments ----------
ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('file-info', (_e, paths) => paths.map((p) => attachments.describe(p)));
ipcMain.handle('save-pasted', (_e, { name, data }) => attachments.savePasted(name, Buffer.from(data)));

// ---------- MCP connectors ----------
ipcMain.handle('mcp-status', () => mcp.status());
ipcMain.handle('mcp-add', async (_e, def) => {
  try {
    const s = mcp.add(def);
    mcp.connect(s.id, { interactive: true }).catch(() => {});
    return { ok: true, id: s.id };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
ipcMain.handle('mcp-connect', async (_e, id) => {
  try {
    await mcp.connect(id, { interactive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
ipcMain.handle('mcp-toggle', (_e, { id, enabled }) => mcp.setEnabled(id, enabled));
ipcMain.handle('mcp-remove', (_e, id) => mcp.remove(id));
ipcMain.handle('mcp-signout', (_e, id) => mcp.signOut(id));
ipcMain.handle('stop', () => agent.stop());
ipcMain.handle('new-chat', () => agent.reset());
ipcMain.handle('approval', (_e, { id, ok }) => {
  const r = pendingApprovals.get(id);
  if (r) {
    pendingApprovals.delete(id);
    r(ok);
  }
});
ipcMain.handle('listen', () => listenOnce());
ipcMain.handle('get-memory', () => loadMemory());
ipcMain.handle('set-memory', (_e, items) => saveMemory(items));
ipcMain.handle('check-updates', () => checkForUpdates(true));
ipcMain.handle('install-update', () => {
  quitting = true;
  autoUpdater.quitAndInstall(false, true);
});
ipcMain.handle('open-logs', () => shell.openPath(path.dirname(log.transports.file.getFile().path)));

// ---------- lifecycle ----------
app.on('second-instance', () => {
  if (win) {
    win.show();
    win.focus();
  }
});

app.whenReady().then(() => {
  app.setAppUserModelId('uk.kivo.jarvis');
  createWindow();
  createTray();
  registerHotkey();
  applyStartup();
  mcp = new McpManager({
    userDir,
    encrypt: encryptText,
    decrypt: decryptText,
    openExternal: (u) => shell.openExternal(u),
    onChange: (st) => send('mcp-status', st),
    log,
  });
  buildAgent();
  mcp.connectAll();
  setTimeout(() => checkForUpdates(false), 5000);
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', (e) => e.preventDefault());
