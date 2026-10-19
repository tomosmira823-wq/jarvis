const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
let settings = {};
let current = null; // { el, body, text }
let tools = {};
let busy = false;

// ---------- tiny markdown ----------
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>');
}
function md(src) {
  const out = [];
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2) {
      const code = part.replace(/^[\w+-]*\n/, '');
      out.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    const blocks = part.split(/\n{2,}/);
    for (const b of blocks) {
      if (!b.trim()) continue;
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l) || !l.trim())) {
        out.push('<ul>' + lines.filter((l) => l.trim()).map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('') + '</ul>');
      } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l) || !l.trim())) {
        out.push('<ol>' + lines.filter((l) => l.trim()).map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('') + '</ol>');
      } else {
        out.push(`<p>${lines.map((l) => inline(l.replace(/^#{1,6}\s+/, ''))).join('<br>')}</p>`);
      }
    }
  });
  return out.join('');
}

// ---------- chat rendering ----------
function scroll() {
  log.scrollTop = log.scrollHeight;
}
function hideEmpty() {
  $('empty').classList.add('hidden');
}
function addUser(text) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  log.appendChild(el);
  scroll();
}
function ensureJarvis() {
  if (current) return current;
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'msg jarvis';
  el.innerHTML = '<div class="who">JARVIS</div><div class="stream"></div>';
  log.appendChild(el);
  current = { el, stream: el.querySelector('.stream'), seg: null, segText: '', all: '' };
  return current;
}
function textSeg() {
  const c = ensureJarvis();
  if (!c.seg) {
    c.seg = document.createElement('div');
    c.seg.className = 'body caret';
    c.stream.appendChild(c.seg);
    c.segText = '';
  }
  return c;
}
function closeSeg() {
  if (current && current.seg) {
    current.seg.classList.remove('caret');
    if (!current.segText.trim()) current.seg.remove();
    current.seg = null;
  }
}
function summarise(name, input) {
  if (!input) return '';
  if (name === 'run_powershell') return input.script.split('\n')[0];
  if (name === 'mouse') return `${input.action}${input.x != null ? ` @ ${input.x},${input.y}` : ''}`;
  if (name === 'keyboard') return input.keys || JSON.stringify(input.text);
  return Object.values(input).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ').split('\n')[0];
}
function addTool(evt) {
  closeSeg();
  const c = ensureJarvis();
  const d = document.createElement('details');
  d.className = 'tool';
  const full = evt.name === 'run_powershell' ? evt.input.script : JSON.stringify(evt.input, null, 2);
  d.innerHTML = `<summary><span class="dot"></span><span class="tname">${esc(evt.name)}</span><span class="tsum">${esc(summarise(evt.name, evt.input))}</span></summary><pre class="in">${esc(full)}</pre><pre class="out">…</pre>`;
  c.stream.appendChild(d);
  tools[evt.id] = d;
  scroll();
}
function toolResult(evt) {
  const d = tools[evt.id];
  if (!d) return;
  d.classList.add(evt.ok ? 'ok' : 'err');
  d.querySelector('.out').textContent = evt.preview || '(no output)';
}
function addApproval(evt) {
  closeSeg();
  const c = ensureJarvis();
  const box = document.createElement('div');
  box.className = 'approval';
  const what = evt.tool === 'run_powershell' ? evt.input.script : JSON.stringify(evt.input, null, 2);
  box.innerHTML = `<div class="t">Allow ${esc(evt.tool)}?</div><pre>${esc(what)}</pre><div class="row"><button class="btn primary">Allow</button><button class="btn danger">Deny</button></div>`;
  const [yes, no] = box.querySelectorAll('button');
  const answer = (ok) => {
    window.jarvis.approve(evt.id, ok);
    box.innerHTML = `<div class="sub">${ok ? 'Allowed' : 'Denied'} ${esc(evt.tool)}</div>`;
  };
  yes.onclick = () => answer(true);
  no.onclick = () => answer(false);
  c.stream.appendChild(box);
  yes.focus();
  scroll();
}
function addError(message) {
  closeSeg();
  const el = document.createElement('div');
  el.className = 'error';
  el.textContent = message;
  (current ? current.stream : log).appendChild(el);
  scroll();
}

// ---------- state ----------
function setBusy(b) {
  busy = b;
  document.body.classList.toggle('busy', b);
  $('send').classList.toggle('hidden', b);
  $('stop').classList.toggle('hidden', !b);
  $('status').textContent = b ? 'Working…' : 'Online';
}

window.jarvis.onEvent((evt) => {
  switch (evt.type) {
    case 'status':
      setBusy(evt.state === 'thinking');
      break;
    case 'text': {
      if (!evt.delta.trim() && !(current && current.seg)) break;
      const c = textSeg();
      c.segText += evt.delta;
      c.all += evt.delta;
      c.seg.innerHTML = md(c.segText);
      scroll();
      break;
    }
    case 'tool':
      addTool(evt);
      break;
    case 'tool-result':
      toolResult(evt);
      break;
    case 'approval':
      addApproval(evt);
      break;
    case 'error':
      addError(evt.message);
      break;
    case 'done': {
      closeSeg();
      if (current && evt.usage && (evt.usage.input || evt.usage.output)) {
        const m = document.createElement('div');
        m.className = 'meta';
        m.textContent = `${evt.stopped ? 'Stopped · ' : ''}${evt.usage.input.toLocaleString()} in · ${evt.usage.output.toLocaleString()} out tokens`;
        current.el.appendChild(m);
      }
      if (!evt.stopped && evt.text) speak(evt.text);
      current = null;
      tools = {};
      break;
    }
  }
});

async function submit(text) {
  text = (text ?? input.value).trim();
  if (!text || busy) return;
  if (!settings.hasApiKey) {
    openSettings();
    $('keyState').textContent = 'Paste your API key first, then Save.';
    $('apiKey').focus();
    return;
  }
  stopSpeaking();
  input.value = '';
  autosize();
  addUser(text);
  current = null;
  setBusy(true);
  window.jarvis.send(text);
}

// ---------- voice ----------
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
  const sel = $('voiceName');
  const prev = settings.voiceName || sel.value;
  sel.innerHTML = '<option value="">Auto (British male if available)</option>' +
    voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
  sel.value = prev || '';
}
speechSynthesis.onvoiceschanged = loadVoices;

function pickVoice() {
  if (settings.voiceName) {
    const v = voices.find((x) => x.name === settings.voiceName);
    if (v) return v;
  }
  return (
    voices.find((v) => /George|Ryan|Thomas/i.test(v.name) && /en-GB/i.test(v.lang)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    null
  );
}
function speak(text) {
  if (!settings.speak) return;
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_#>|]/g, '')
    .trim()
    .slice(0, 1200);
  if (!clean) return;
  const u = new SpeechSynthesisUtterance(clean);
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.04;
  u.onstart = () => document.body.classList.add('speaking');
  u.onend = u.onerror = () => document.body.classList.remove('speaking');
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function stopSpeaking() {
  speechSynthesis.cancel();
  document.body.classList.remove('speaking');
}

async function listen() {
  if (busy || document.body.classList.contains('listening')) return;
  stopSpeaking();
  document.body.classList.add('listening');
  $('status').textContent = 'Listening…';
  const r = await window.jarvis.listen();
  document.body.classList.remove('listening');
  $('status').textContent = 'Online';
  if (r.ok) submit(r.text);
  else {
    $('foot').textContent = r.message;
    setTimeout(resetFoot, 4000);
  }
}
function resetFoot() {
  $('foot').innerHTML = `Enter to send · Shift+Enter new line · Ctrl+M to talk · ${esc(settings.hotkey || '')} to summon`;
}

// ---------- settings ----------
function openSettings() {
  document.body.classList.add('settings-open');
  $('drawer').setAttribute('aria-hidden', 'false');
  refreshMemory();
}
function closeSettings() {
  document.body.classList.remove('settings-open');
  $('drawer').setAttribute('aria-hidden', 'true');
  input.focus();
}
function fillSettings() {
  $('apiKey').value = '';
  $('apiKey').placeholder = settings.hasApiKey ? `Saved (${settings.apiKeyHint}) — paste to replace` : 'sk-ant-…';
  $('keyState').textContent = settings.hasApiKey ? 'Key saved, encrypted on this PC.' : 'Stored encrypted on this PC. Get one at console.anthropic.com → API keys.';
  $('model').value = settings.model;
  $('callMe').value = settings.callMe || '';
  $('speak').checked = !!settings.speak;
  $('hotkey').value = settings.hotkey || '';
  $('askBeforeActions').checked = !!settings.askBeforeActions;
  $('webSearch').checked = !!settings.webSearch;
  $('launchAtStartup').checked = !!settings.launchAtStartup;
  $('startHidden').checked = !!settings.startHidden;
  $('versionLine').textContent = `Jarvis v${settings.version}`;
  loadVoices();
  resetFoot();
}
async function refreshMemory() {
  const items = await window.jarvis.getMemory();
  const ul = $('memory');
  if (!items.length) {
    ul.innerHTML = '<li class="none">Nothing yet. Tell Jarvis "remember that…"</li>';
    return;
  }
  ul.innerHTML = '';
  items.forEach((m, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(m.fact)}</span><button title="Forget">✕</button>`;
    li.querySelector('button').onclick = async () => {
      items.splice(i, 1);
      await window.jarvis.setMemory(items);
      refreshMemory();
    };
    ul.appendChild(li);
  });
}
async function saveSettings() {
  const payload = {
    model: $('model').value,
    callMe: $('callMe').value.trim() || 'sir',
    speak: $('speak').checked,
    voiceName: $('voiceName').value,
    hotkey: $('hotkey').value.trim(),
    askBeforeActions: $('askBeforeActions').checked,
    webSearch: $('webSearch').checked,
    launchAtStartup: $('launchAtStartup').checked,
    startHidden: $('startHidden').checked,
  };
  const key = $('apiKey').value.trim();
  if (key) payload.apiKey = key;
  const r = await window.jarvis.saveSettings(payload);
  settings = await window.jarvis.getSettings();
  fillSettings();
  $('saveMsg').textContent = r.hotkeyOk ? 'Saved.' : 'Saved — but that hotkey is taken or invalid.';
  setTimeout(() => ($('saveMsg').textContent = ''), 3000);
  greet();
}

// ---------- updates ----------
window.jarvis.onUpdate((u) => {
  const b = $('updateBanner');
  const t = $('updateText');
  const btn = $('installUpdate');
  if (u.state === 'ready') {
    b.classList.remove('hidden');
    btn.classList.remove('hidden');
    t.textContent = `Jarvis v${u.version} is ready.`;
  } else if (u.state === 'downloading') {
    b.classList.remove('hidden');
    btn.classList.add('hidden');
    t.textContent = u.percent != null ? `Downloading update… ${u.percent}%` : `Downloading v${u.version}…`;
  } else if (u.state === 'latest') {
    $('versionLine').textContent = `Jarvis v${u.version} — up to date`;
  } else if (u.state === 'error' || u.state === 'dev') {
    $('versionLine').textContent = `Jarvis v${settings.version} — ${u.message}`;
  } else if (u.state === 'checking') {
    $('versionLine').textContent = `Jarvis v${settings.version} — checking…`;
  }
});

// ---------- misc ----------
function greet() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('greeting').textContent = `${part}, ${settings.callMe || 'sir'}.`;
  $('emptyHint').textContent = settings.hasApiKey ? 'What can I do for you?' : 'Add your Anthropic API key in Settings to bring me online.';
}
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
async function newChat() {
  await window.jarvis.newChat();
  stopSpeaking();
  current = null;
  tools = {};
  [...log.children].forEach((c) => c.id !== 'empty' && c.remove());
  $('empty').classList.remove('hidden');
  input.focus();
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.body.classList.contains('settings-open')) closeSettings();
    else if (busy) window.jarvis.stop();
    else stopSpeaking();
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    listen();
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat();
  }
});
$('send').onclick = () => submit();
$('stop').onclick = () => window.jarvis.stop();
$('mic').onclick = listen;
$('newChat').onclick = newChat;
$('openSettings').onclick = openSettings;
$('closeSettings').onclick = closeSettings;
$('scrim').onclick = closeSettings;
$('saveSettings').onclick = saveSettings;
$('installUpdate').onclick = () => window.jarvis.installUpdate();
$('checkUpdates').onclick = () => window.jarvis.checkUpdates();
$('openLogs').onclick = () => window.jarvis.openLogs();
$('testKey').onclick = async () => {
  $('keyState').textContent = 'Testing…';
  const r = await window.jarvis.testKey($('apiKey').value.trim());
  $('keyState').textContent = r.ok ? 'Key works.' : `Failed: ${r.message}`;
};
document.querySelectorAll('.chip').forEach((c) => (c.onclick = () => submit(c.textContent)));
window.jarvis.onFocusInput(() => input.focus());

(async () => {
  settings = await window.jarvis.getSettings();
  fillSettings();
  greet();
  if (!settings.hasApiKey) openSettings();
  input.focus();
})();
