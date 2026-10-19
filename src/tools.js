// Everything Jarvis can physically do on the PC.
const { spawn } = require('child_process');
const { shell, desktopCapturer, screen, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_OUT = 20000;
const SHOT_WIDTH = 1280;

function clip(s, n = MAX_OUT) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

function expandPath(p) {
  if (!p) return p;
  p = p.replace(/^~(?=$|[\\/])/, os.homedir());
  return p.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
}

// ---------- PowerShell ----------
function runPowerShell(script, { timeoutS = 120, signal } = {}) {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), `jarvis-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    const body =
      "$ErrorActionPreference='Continue'\n" +
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n' +
      "$OutputEncoding=[System.Text.Encoding]::UTF8\n" +
      script;
    fs.writeFileSync(file, '﻿' + body, 'utf8');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, cwd: os.homedir() }
    );
    let out = '';
    let err = '';
    let finished = false;
    const done = (code, note) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fs.rm(file, { force: true }, () => {});
      resolve({ code, stdout: out, stderr: err, note });
    };
    const kill = (note) => {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
      done(-1, note);
    };
    const timer = setTimeout(() => kill(`Timed out after ${timeoutS}s and was stopped.`), timeoutS * 1000);
    signal?.addEventListener('abort', () => kill('Stopped by user.'), { once: true });
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      err += e.message;
      done(-1);
    });
    child.on('close', (code) => done(code));
  });
}

function formatPs(r) {
  let s = '';
  if (r.stdout.trim()) s += r.stdout.trimEnd();
  if (r.stderr.trim()) s += (s ? '\n' : '') + 'STDERR:\n' + r.stderr.trimEnd();
  if (r.note) s += (s ? '\n' : '') + r.note;
  s += `${s ? '\n' : ''}[exit code ${r.code}]`;
  return clip(s);
}

// ---------- mouse & keyboard (Win32 via PowerShell) ----------
const WIN32 = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class JV {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
}
"@
[JV]::SetProcessDPIAware() | Out-Null
function Down($f){ [JV]::mouse_event($f,0,0,0,[UIntPtr]::Zero) }
`;

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b, cmd: 0x5b, super: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e,
  insert: 0x2d, space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, printscreen: 0x2c, capslock: 0x14, menu: 0x5d,
  volumeup: 0xaf, volumedown: 0xae, mute: 0xad, playpause: 0xb3, nexttrack: 0xb0, prevtrack: 0xb1,
};

function vkFor(name) {
  const n = name.toLowerCase().trim();
  if (VK[n] != null) return VK[n];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(n)) return 0x6f + Number(n.slice(1));
  if (/^[a-z]$/.test(n)) return n.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(n)) return n.charCodeAt(0);
  const punct = { ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde };
  if (punct[n] != null) return punct[n];
  throw new Error(`Unknown key "${name}"`);
}

function keyComboScript(combo) {
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Empty key combo');
  const codes = parts.map(vkFor);
  let s = '';
  for (const c of codes) s += `[JV]::keybd_event(${c},0,0,[UIntPtr]::Zero)\nStart-Sleep -Milliseconds 25\n`;
  for (const c of [...codes].reverse()) s += `[JV]::keybd_event(${c},0,2,[UIntPtr]::Zero)\nStart-Sleep -Milliseconds 25\n`;
  return s;
}

function sendKeysEscape(text) {
  return text
    .replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`)
    .replace(/\r?\n/g, '{ENTER}')
    .replace(/\t/g, '{TAB}');
}

// ---------- screenshots ----------
let shotScale = 1; // physical pixels per screenshot pixel
let shotOrigin = { x: 0, y: 0 };

async function takeScreenshot() {
  const display = screen.getPrimaryDisplay();
  const physW = Math.round(display.size.width * display.scaleFactor);
  const physH = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physW, height: physH } });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src) throw new Error('No screen available to capture');
  let img = src.thumbnail;
  const realW = img.getSize().width || physW;
  if (realW > SHOT_WIDTH) img = img.resize({ width: SHOT_WIDTH, quality: 'good' });
  const size = img.getSize();
  shotScale = physW / size.width;
  shotOrigin = { x: Math.round(display.bounds.x * display.scaleFactor), y: Math.round(display.bounds.y * display.scaleFactor) };
  const jpeg = img.toJPEG(80);
  return { base64: jpeg.toString('base64'), width: size.width, height: size.height };
}

function toScreen(x, y) {
  return [Math.round(shotOrigin.x + x * shotScale), Math.round(shotOrigin.y + y * shotScale)];
}

// ---------- web ----------
async function fetchUrl(url, signal) {
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Jarvis/1.0' },
  });
  const type = res.headers.get('content-type') || '';
  let body = await res.text();
  if (type.includes('html')) {
    body = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n');
  }
  return clip(`HTTP ${res.status} ${type}\n\n${body.trim()}`, 30000);
}

// ---------- tool definitions ----------
const DEFINITIONS = [
  {
    name: 'run_powershell',
    description:
      'Run a Windows PowerShell 5.1 script on the user\'s PC and get stdout/stderr/exit code. This is your main way to do things: launch apps (Start-Process), manage files and folders, query system info, change volume, kill processes, install things with winget, run git/python/node, schedule tasks, etc. Runs as the current user, not elevated. Commands that need a GUI should be started with Start-Process so they do not block.',
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'PowerShell script to run.' },
        timeout_seconds: { type: 'integer', description: 'Max seconds before it is killed. Default 120, max 1800.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the PC. Supports ~ and %ENV% in paths.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file (UTF-8). Parent folders are created.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory with sizes and modified dates.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'open',
    description: 'Open a URL in the default browser, or a file/folder/app with its default handler.',
    input_schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  },
  {
    name: 'screenshot',
    description:
      'Take a screenshot of the primary monitor. Jarvis\'s own window is minimised first. Use this before clicking so you know where things are. Coordinates you pass to mouse use this image\'s pixel grid.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'mouse',
    description:
      'Move/click/scroll/drag the mouse. x and y are pixel positions in the most recent screenshot. Take a fresh screenshot afterwards to confirm the result.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'left_click', 'double_click', 'right_click', 'middle_click', 'scroll', 'drag'] },
        x: { type: 'integer' },
        y: { type: 'integer' },
        to_x: { type: 'integer', description: 'For drag: end x.' },
        to_y: { type: 'integer', description: 'For drag: end y.' },
        scroll_amount: { type: 'integer', description: 'For scroll: notches, positive = up, negative = down.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'keyboard',
    description:
      'Type text into whatever has focus, or press a key combination. Use either text OR keys. keys examples: "enter", "ctrl+s", "alt+tab", "win+r", "ctrl+shift+esc", "f5", "volumeup".',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Literal text to type.' },
        keys: { type: 'string', description: 'Key combo joined with +.' },
      },
    },
  },
  {
    name: 'clipboard',
    description: 'Read or set the Windows clipboard text.',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['read', 'write'] }, text: { type: 'string' } },
      required: ['action'],
    },
  },
  {
    name: 'fetch_url',
    description: 'Download a web page or API response and return it as text (HTML is stripped).',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'remember',
    description:
      'Save a long-term fact or preference about the user so you know it in every future chat (e.g. where their projects live, how they like things done).',
    input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
  },
  {
    name: 'forget',
    description: 'Remove saved memories that contain the given text.',
    input_schema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] },
  },
];

// Tools that change things on the PC (used for "ask before actions" mode).
const ACTION_TOOLS = new Set(['run_powershell', 'write_file', 'open', 'mouse', 'keyboard', 'clipboard']);
// Tools that need the screen clear of Jarvis's own window.
const SCREEN_TOOLS = new Set(['screenshot', 'mouse', 'keyboard']);

async function execute(name, input, ctx) {
  const { signal } = ctx;
  switch (name) {
    case 'run_powershell': {
      const t = Math.min(Math.max(Number(input.timeout_seconds) || 120, 1), 1800);
      return formatPs(await runPowerShell(input.script, { timeoutS: t, signal }));
    }
    case 'read_file': {
      const p = expandPath(input.path);
      const buf = fs.readFileSync(p);
      if (buf.includes(0)) return `${p} looks like a binary file (${buf.length} bytes); not shown.`;
      return clip(buf.toString('utf8'), 60000);
    }
    case 'write_file': {
      const p = expandPath(input.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, input.content, 'utf8');
      return `Wrote ${Buffer.byteLength(input.content)} bytes to ${p}`;
    }
    case 'list_directory': {
      const p = expandPath(input.path);
      const rows = fs.readdirSync(p, { withFileTypes: true }).slice(0, 500).map((d) => {
        let info = '';
        try {
          const st = fs.statSync(path.join(p, d.name));
          info = d.isDirectory() ? '<DIR>' : `${st.size} B`;
          info += `  ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}`;
        } catch {}
        return `${d.isDirectory() ? '[D]' : '   '} ${d.name}  ${info}`;
      });
      return clip(`${p}\n${rows.join('\n') || '(empty)'}`);
    }
    case 'open': {
      const t = input.target.trim();
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(mailto|ms-settings|spotify|steam):/i.test(t)) {
        await shell.openExternal(t);
        return `Opened ${t}`;
      }
      const err = await shell.openPath(expandPath(t));
      return err ? `Could not open: ${err}` : `Opened ${t}`;
    }
    case 'screenshot': {
      await new Promise((r) => setTimeout(r, 350));
      const s = await takeScreenshot();
      return [
        { type: 'text', text: `Screenshot ${s.width}x${s.height}. Use these pixel coordinates for mouse actions.` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.base64 } },
      ];
    }
    case 'mouse': {
      const a = input.action;
      let s = WIN32;
      const need = (k) => {
        if (typeof input[k] !== 'number') throw new Error(`mouse ${a} needs ${k}`);
      };
      if (a !== 'scroll' || input.x != null) {
        need('x');
        need('y');
        const [x, y] = toScreen(input.x, input.y);
        s += `[JV]::SetCursorPos(${x},${y}) | Out-Null\nStart-Sleep -Milliseconds 60\n`;
      }
      const click = (dn, up) => `Down ${dn}\nStart-Sleep -Milliseconds 40\nDown ${up}\n`;
      if (a === 'left_click') s += click(0x02, 0x04);
      else if (a === 'double_click') s += click(0x02, 0x04) + 'Start-Sleep -Milliseconds 80\n' + click(0x02, 0x04);
      else if (a === 'right_click') s += click(0x08, 0x10);
      else if (a === 'middle_click') s += click(0x20, 0x40);
      else if (a === 'scroll') {
        const n = Number(input.scroll_amount) || -3;
        s += `[JV]::mouse_event(0x0800,0,0,${n * 120},[UIntPtr]::Zero)\n`;
      } else if (a === 'drag') {
        need('to_x');
        need('to_y');
        const [fx, fy] = toScreen(input.x, input.y);
        const [tx, ty] = toScreen(input.to_x, input.to_y);
        s += `Down 0x02\nStart-Sleep -Milliseconds 120\n`;
        for (let i = 1; i <= 10; i++) {
          const mx = Math.round(fx + ((tx - fx) * i) / 10);
          const my = Math.round(fy + ((ty - fy) * i) / 10);
          s += `[JV]::SetCursorPos(${mx},${my}) | Out-Null\nStart-Sleep -Milliseconds 25\n`;
        }
        s += `Down 0x04\n`;
      } else if (a !== 'move') throw new Error(`Unknown mouse action ${a}`);
      const r = await runPowerShell(s, { timeoutS: 20, signal });
      return r.code === 0 ? `mouse ${a} done` : formatPs(r);
    }
    case 'keyboard': {
      let s = WIN32;
      if (input.keys) s += keyComboScript(input.keys);
      else if (typeof input.text === 'string') {
        s += 'Add-Type -AssemblyName System.Windows.Forms\n';
        const esc = sendKeysEscape(input.text).replace(/'/g, "''");
        s += `[System.Windows.Forms.SendKeys]::SendWait('${esc}')\n`;
      } else throw new Error('keyboard needs text or keys');
      const r = await runPowerShell(s, { timeoutS: 60, signal });
      return r.code === 0 ? (input.keys ? `pressed ${input.keys}` : `typed ${input.text.length} characters`) : formatPs(r);
    }
    case 'clipboard': {
      if (input.action === 'write') {
        clipboard.writeText(input.text ?? '');
        return 'Clipboard set.';
      }
      return clip(clipboard.readText() || '(clipboard is empty or not text)');
    }
    case 'fetch_url':
      return fetchUrl(input.url, signal);
    case 'remember': {
      const mem = ctx.loadMemory();
      mem.push({ fact: input.fact, at: new Date().toISOString() });
      ctx.saveMemory(mem);
      return 'Saved to long-term memory.';
    }
    case 'forget': {
      const mem = ctx.loadMemory();
      const m = input.match.toLowerCase();
      const keep = mem.filter((x) => !x.fact.toLowerCase().includes(m));
      ctx.saveMemory(keep);
      return `Removed ${mem.length - keep.length} memory item(s).`;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

module.exports = { DEFINITIONS, ACTION_TOOLS, SCREEN_TOOLS, execute, runPowerShell, sendKeysEscape, keyComboScript };
