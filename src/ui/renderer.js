const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
let settings = {};
let current = null;
let tools = {};
let busy = false;
let sessionTokens = 0;
let pending = []; // attachments waiting to be sent
let mcpServers = [];

// ---------- helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  src.split(/```/).forEach((part, i) => {
    if (i % 2) {
      out.push(`<pre><code>${esc(part.replace(/^[\w+-]*\n/, '').replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    for (const b of part.split(/\n{2,}/)) {
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
const hhmmss = (d = new Date()) => d.toLocaleTimeString('en-GB', { hour12: false });
function fmtBytes(b) {
  if (!b && b !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}

// ---------- HUD state ----------
let errorTimer = null;
function hudState(state, sub) {
  const labels = {
    idle: ['STANDING BY', 'Awaiting instruction'],
    thinking: ['PROCESSING', 'Working on it'],
    listening: ['LISTENING', 'Go ahead'],
    speaking: ['SPEAKING', ''],
    error: ['ALERT', ''],
  };
  const [main, defSub] = labels[state] || labels.idle;
  $('stateMain').textContent = main;
  $('stateSub').textContent = sub ?? defSub;
  window.Reactor.setState(state);
}
function settleState() {
  if (busy) hudState('thinking');
  else if (document.body.classList.contains('listening')) hudState('listening');
  else if (document.body.classList.contains('speaking')) hudState('speaking', 'Voice output active');
  else hudState('idle');
}

// ---------- clock ----------
function tickClock() {
  const d = new Date();
  $('clock').textContent = hhmmss(d);
  $('date').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

// ---------- system stats ----------
const cpuHistory = [];
const spark = $('cpuSpark');
function drawSpark() {
  const r = spark.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  spark.width = r.width * dpr;
  spark.height = r.height * dpr;
  const c = spark.getContext('2d');
  c.scale(dpr, dpr);
  c.clearRect(0, 0, r.width, r.height);
  if (cpuHistory.length < 2) return;
  const step = r.width / 59;
  c.beginPath();
  cpuHistory.forEach((v, i) => {
    const x = r.width - (cpuHistory.length - 1 - i) * step;
    const y = r.height - 4 - (v / 100) * (r.height - 10);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  });
  c.strokeStyle = 'rgba(95,220,255,.9)';
  c.lineWidth = 1.5;
  c.shadowColor = '#5fdcff';
  c.shadowBlur = 6;
  c.stroke();
  c.lineTo(r.width, r.height);
  c.lineTo(r.width - (cpuHistory.length - 1) * step, r.height);
  c.closePath();
  const g = c.createLinearGradient(0, 0, 0, r.height);
  g.addColorStop(0, 'rgba(95,220,255,.22)');
  g.addColorStop(1, 'rgba(95,220,255,0)');
  c.fillStyle = g;
  c.shadowBlur = 0;
  c.fill();
}
async function pollStats() {
  try {
    const s = await window.jarvis.sysStats();
    const cpu = s.cpu;
    cpuHistory.push(cpu);
    if (cpuHistory.length > 60) cpuHistory.shift();
    $('cpuPct').textContent = cpu;
    const arc = $('cpuArc');
    arc.style.strokeDasharray = `${(cpu / 100) * 314.16} 314.16`;
    arc.style.stroke = cpu > 85 ? 'var(--red)' : cpu > 65 ? 'var(--amber)' : 'var(--c)';
    $('loadWord').textContent = cpu > 85 ? 'CRITICAL' : cpu > 65 ? 'HEAVY' : cpu > 30 ? 'ACTIVE' : 'NOMINAL';
    $('cores').textContent = `${s.cores} THREADS`;
    $('uptime').textContent = fmtUptime(s.uptime);
    const memPct = (s.memUsed / s.memTotal) * 100;
    $('memTxt').textContent = `${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}`;
    $('memBar').style.width = memPct + '%';
    $('memBar').classList.toggle('warn', memPct > 85);
    if (s.disk) {
      const dp = (s.disk.used / s.disk.total) * 100;
      $('diskTxt').textContent = `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}`;
      $('diskBar').style.width = dp + '%';
      $('diskBar').classList.toggle('warn', dp > 90);
    }
    $('host').textContent = s.host.toUpperCase();
    $('user').textContent = s.user;
    $('ip').textContent = s.ip;
    $('cpuName').textContent = s.cpuName;
    $('cpuName').title = s.cpuName;
    drawSpark();
  } catch {}
}
setInterval(pollStats, 1500);

function refreshCoreStatus() {
  const names = { 'claude-opus-5-5': 'OPUS 5.5', 'claude-sonnet-5-5': 'SONNET 5.5', 'claude-haiku-5-5': 'HAIKU 5.5' };
  $('modelName').textContent = names[settings.model] || settings.model;
  const a = $('authority');
  a.textContent = settings.askBeforeActions ? 'SUPERVISED' : 'FULL CONTROL';
  a.className = settings.askBeforeActions ? 'warn' : 'ok';
  const v = $('voiceState');
  v.textContent = settings.speak ? 'ONLINE' : 'MUTED';
  v.className = settings.speak ? 'ok' : 'warn';
  const u = $('uplink');
  u.textContent = settings.hasApiKey ? 'ESTABLISHED' : 'NO KEY';
  u.className = settings.hasApiKey ? 'ok' : 'bad';
  $('linkDot').className = 'dot' + (settings.hasApiKey ? '' : ' bad');
  $('linkTxt').textContent = settings.hasApiKey ? 'SECURE LINK' : 'NO UPLINK — ADD API KEY';
  $('build').textContent = 'v' + settings.version;
}

// ---------- activity feed + memory bank ----------
const feedItems = {};
function feedAdd(evt) {
  const feed = $('feed');
  feed.querySelector('.none')?.remove();
  const li = document.createElement('li');
  li.innerHTML = `<span class="fdot"></span><div><div><span class="fn">${esc(prettyTool(evt.name))}</span> <span class="ft">${hhmmss()}</span></div><div class="fs">${esc(summarise(evt.name, evt.input))}</div></div>`;
  feed.prepend(li);
  feedItems[evt.id] = li;
  while (feed.children.length > 40) feed.lastChild.remove();
}
function feedDone(evt) {
  const li = feedItems[evt.id];
  if (li) li.classList.add(evt.ok ? 'ok' : 'err');
  delete feedItems[evt.id];
}
async function refreshMembank() {
  const items = await window.jarvis.getMemory();
  const ul = $('membank');
  ul.innerHTML = items.length
    ? items.slice(-8).reverse().map((m) => `<li>${esc(m.fact)}</li>`).join('')
    : '<li class="none">Empty. Say "remember that…"</li>';
}

// ---------- chat rendering ----------
function scroll() {
  log.scrollTop = log.scrollHeight;
}
function startChatLayout() {
  $('empty').classList.add('hidden');
  document.body.classList.add('chatting');
}
function addUser(text, files = []) {
  startChatLayout();
  const el = document.createElement('div');
  el.className = 'msg user';
  const fileHtml = files.length
    ? `<div class="files">${files.map((f) => (f.thumb && files.length <= 3 ? `<div class="chip big" title="${esc(f.path)}"><img src="${f.thumb}"></div>` : chipHtml(f, false))).join('')}</div>`
    : '';
  el.innerHTML = `<div class="who"><time>${hhmmss()}</time>${esc((settings.callMe || 'YOU').toUpperCase())}</div>${fileHtml}${text ? `<div class="bubble">${esc(text)}</div>` : ''}`;
  log.appendChild(el);
  scroll();
}
function ensureJarvis() {
  if (current) return current;
  startChatLayout();
  const el = document.createElement('div');
  el.className = 'msg jarvis';
  el.innerHTML = `<div class="who">JARVIS<time>${hhmmss()}</time></div><div class="stream"></div>`;
  log.appendChild(el);
  current = { el, stream: el.querySelector('.stream'), seg: null, segText: '' };
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
  if (name === 'run_powershell') return (input.script || '').split('\n')[0];
  if (name === 'mouse') return `${input.action}${input.x != null ? ` @ ${input.x},${input.y}` : ''}`;
  if (name === 'keyboard') return input.keys || JSON.stringify(input.text);
  if (name === 'screenshot') return 'capturing primary display';
  if (name === 'tool_search') return `searching connectors: ${input.query || input.pattern || ''}`;
  if (name === 'download_file') return input.url;
  return Object.values(input).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ').split('\n')[0];
}
function prettyTool(name) {
  const m = /^mcp_([a-z0-9_]+?)__(.+)$/.exec(name);
  return m ? `${m[1]} › ${m[2]}` : name;
}
function addTool(evt) {
  closeSeg();
  const c = ensureJarvis();
  const d = document.createElement('details');
  d.className = 'tool';
  const full = evt.name === 'run_powershell' ? evt.input.script : JSON.stringify(evt.input, null, 2);
  d.innerHTML = `<summary><span class="tag2">EXEC</span><span class="tname">${esc(prettyTool(evt.name))}</span><span class="tsum">${esc(summarise(evt.name, evt.input))}</span></summary><pre class="in">${esc(full)}</pre><pre class="out">…</pre>`;
  c.stream.appendChild(d);
  tools[evt.id] = d;
  feedAdd(evt);
  $('stateSub').textContent = `Executing ${prettyTool(evt.name).replace(/_/g, ' ')}`;
  scroll();
}
function toolResult(evt) {
  feedDone(evt);
  const d = tools[evt.id];
  if (!d) return;
  d.classList.add(evt.ok ? 'ok' : 'err');
  d.querySelector('.tag2').textContent = evt.ok ? 'DONE' : 'FAIL';
  d.querySelector('.out').textContent = evt.preview || '(no output)';
  if (busy) $('stateSub').textContent = 'Working on it';
}
function addApproval(evt) {
  closeSeg();
  const c = ensureJarvis();
  const box = document.createElement('div');
  box.className = 'approval';
  const what = evt.tool === 'run_powershell' ? evt.input.script : JSON.stringify(evt.input, null, 2);
  box.innerHTML = `<div class="t">Authorisation required — ${esc(evt.tool)}</div><pre>${esc(what)}</pre><div class="row"><button class="hbtn solid">Authorise</button><button class="hbtn danger">Deny</button></div>`;
  const [yes, no] = box.querySelectorAll('button');
  const answer = (ok) => {
    window.jarvis.approve(evt.id, ok);
    box.innerHTML = `<div class="t" style="margin:0">${ok ? 'Authorised' : 'Denied'} — ${esc(evt.tool)}</div>`;
    settleState();
  };
  yes.onclick = () => answer(true);
  no.onclick = () => answer(false);
  c.stream.appendChild(box);
  hudState('listening', 'Awaiting your authorisation');
  yes.focus();
  scroll();
}
function addError(message) {
  closeSeg();
  const el = document.createElement('div');
  el.className = 'error';
  el.textContent = message;
  (current ? current.stream : log).appendChild(el);
  startChatLayout();
  hudState('error', 'See message');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(settleState, 3500);
  scroll();
}

function setBusy(b) {
  busy = b;
  document.body.classList.toggle('busy', b);
  $('send').classList.toggle('hidden', b);
  $('stop').classList.toggle('hidden', !b);
  if (b) hudState('thinking');
  else if (Reactor.state !== 'error') settleState();
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
      c.seg.innerHTML = md(c.segText);
      window.Reactor.pulse();
      scroll();
      break;
    }
    case 'tool':
      addTool(evt);
      break;
    case 'tool-result':
      toolResult(evt);
      if (evt.ok && /memory/i.test(evt.preview)) refreshMembank();
      break;
    case 'approval':
      addApproval(evt);
      break;
    case 'error':
      addError(evt.message);
      break;
    case 'done': {
      closeSeg();
      if (evt.usage && (evt.usage.input || evt.usage.output)) {
        sessionTokens += evt.usage.input + evt.usage.output;
        $('tokens').textContent = sessionTokens.toLocaleString();
        if (current) {
          const m = document.createElement('div');
          m.className = 'meta';
          m.textContent = `${evt.stopped ? 'ABORTED · ' : ''}${evt.usage.input.toLocaleString()} IN · ${evt.usage.output.toLocaleString()} OUT`;
          current.el.appendChild(m);
        }
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
  if ((!text && !pending.length) || busy) return;
  if (!settings.hasApiKey) {
    openSettings();
    $('keyState').textContent = 'Paste your API key first, then Save.';
    $('apiKey').focus();
    return;
  }
  stopSpeaking();
  input.value = '';
  autosize();
  const files = pending.filter((f) => f.kind !== 'missing');
  pending = [];
  renderTray();
  addUser(text, files);
  current = null;
  setBusy(true);
  window.jarvis.send(text, files.map((f) => f.path));
}

// ---------- attachments ----------
const KIND_LABEL = { image: 'IMG', pdf: 'PDF', text: 'TXT', file: 'FILE', folder: 'DIR', missing: '!' };
function chipHtml(f, removable, i) {
  const th = f.thumb ? `<img src="${f.thumb}">` : esc(KIND_LABEL[f.kind] || 'FILE');
  return `<div class="chip ${f.kind === 'missing' ? 'missing' : ''}" title="${esc(f.path)}"><span class="th">${th}</span><span><div class="nm">${esc(f.name)}</div><div class="sz">${esc(f.size || f.error || '')}</div></span>${removable ? `<button class="x" data-i="${i}" title="Remove">✕</button>` : ''}</div>`;
}
function renderTray() {
  const tray = $('tray');
  tray.classList.toggle('hidden', !pending.length);
  tray.innerHTML = pending.map((f, i) => chipHtml(f, true, i)).join('');
  tray.querySelectorAll('.x').forEach((b) => (b.onclick = () => { pending.splice(Number(b.dataset.i), 1); renderTray(); }));
}
async function addFiles(paths) {
  paths = paths.filter((p) => p && !pending.some((f) => f.path === p));
  if (!paths.length) return;
  pending.push(...(await window.jarvis.fileInfo(paths)));
  renderTray();
  input.focus();
}
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const paths = [...(e.dataTransfer?.files || [])].map((f) => window.jarvis.pathForFile(f)).filter(Boolean);
  addFiles(paths);
});
input.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const paths = [];
  for (const f of files) {
    const p = window.jarvis.pathForFile(f);
    if (p) paths.push(p);
    else paths.push(await window.jarvis.savePasted(f.name || 'pasted.png', new Uint8Array(await f.arrayBuffer())));
  }
  addFiles(paths);
});

// ---------- connectors ----------
const STATUS_LABEL = { connected: 'Online', connecting: 'Connecting', 'needs-auth': 'Sign in', error: 'Error', disabled: 'Off', disconnected: 'Offline' };
function renderServers() {
  const ul = $('servers');
  $('addHiggs').classList.toggle('hidden', mcpServers.some((s) => /mcp\.higgsfield\.ai/.test(s.url || '')));
  if (!mcpServers.length) {
    ul.innerHTML = '<li class="none">None yet. Add Higgsfield in one click, or any MCP server.</li>';
  } else {
    ul.innerHTML = '';
    for (const s of mcpServers) {
      const li = document.createElement('li');
      const where = s.type === 'stdio' ? [s.command, ...(s.args || [])].join(' ') : s.url;
      const primary =
        s.status === 'needs-auth' ? '<button class="hbtn solid" data-a="connect">Sign in</button>'
        : s.status === 'error' || s.status === 'disconnected' ? '<button class="hbtn" data-a="connect">Reconnect</button>'
        : '';
      li.innerHTML = `<div class="srv-top"><div style="min-width:0"><div class="srv-name">${esc(s.name)}</div><div class="srv-url">${esc(where || '')}</div></div><span class="pill st-${s.status}">${STATUS_LABEL[s.status] || s.status}${s.status === 'connected' ? ` · ${s.toolCount}` : ''}</span></div>
        ${s.error && s.status === 'error' ? `<div class="srv-err">${esc(s.error)}</div>` : ''}
        <div class="srv-actions">${primary}
          <button class="hbtn" data-a="toggle">${s.enabled ? 'Disable' : 'Enable'}</button>
          ${s.type === 'http' && s.status === 'connected' ? '<button class="hbtn" data-a="signout">Sign out</button>' : ''}
          <button class="hbtn danger" data-a="remove">Remove</button></div>`;
      li.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => serverAction(s, b.dataset.a)));
      ul.appendChild(li);
    }
  }
  const on = mcpServers.filter((s) => s.status === 'connected');
  const cs = $('connState');
  cs.textContent = mcpServers.length ? `${on.length}/${mcpServers.length} ONLINE` : 'NONE';
  cs.className = !mcpServers.length ? '' : on.length === mcpServers.filter((s) => s.enabled).length ? 'ok' : 'warn';
}
async function serverAction(s, a) {
  if (a === 'connect') {
    $('srvMsg').textContent = s.type === 'http' ? 'A browser window may open to sign in…' : '';
    const r = await window.jarvis.mcpConnect(s.id);
    if (!r.ok) alertBox(`${s.name}: ${r.message}`);
  } else if (a === 'toggle') await window.jarvis.mcpToggle(s.id, !s.enabled);
  else if (a === 'signout') await window.jarvis.mcpSignOut(s.id);
  else if (a === 'remove' && confirm(`Remove ${s.name}?`)) await window.jarvis.mcpRemove(s.id);
  mcpServers = await window.jarvis.mcpStatus();
  renderServers();
}
function alertBox(msg) {
  $('srvMsg').textContent = msg;
}
window.jarvis.onMcp((st) => {
  mcpServers = st;
  renderServers();
});

// ---------- voice out ----------
let voices = [];
let speakTimer = null;
function loadVoices() {
  voices = speechSynthesis.getVoices();
  const sel = $('voiceName');
  const prev = settings.voiceName || sel.value;
  sel.innerHTML = '<option value="">Auto (British male if available)</option>' + voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
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
function speak(text, force) {
  if (!settings.speak && !force) return;
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
  u.onstart = () => {
    document.body.classList.add('speaking');
    if (!busy) hudState('speaking', 'Voice output active');
    clearInterval(speakTimer);
    // the speech API gives no audio levels, so animate a believable envelope
    speakTimer = setInterval(() => window.Reactor.setLevel(0.35 + Math.random() * 0.55), 90);
  };
  u.onboundary = () => window.Reactor.pulse();
  u.onend = u.onerror = () => {
    clearInterval(speakTimer);
    window.Reactor.setLevel(0);
    document.body.classList.remove('speaking');
    settleState();
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function stopSpeaking() {
  speechSynthesis.cancel();
  clearInterval(speakTimer);
  window.Reactor.setLevel(0);
  document.body.classList.remove('speaking');
}

// ---------- voice in ----------
let micStream = null;
let micRaf = null;
async function startMicMeter() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(micStream);
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      window.Reactor.setLevel(Math.min(1, peak / 50));
      micRaf = requestAnimationFrame(loop);
    };
    loop();
    micStream._ac = ac;
  } catch {
    window.Reactor.setLevel(0.4);
  }
}
function stopMicMeter() {
  cancelAnimationFrame(micRaf);
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream._ac?.close();
    micStream = null;
  }
  window.Reactor.setLevel(0);
}
async function listen() {
  if (busy || document.body.classList.contains('listening')) return;
  stopSpeaking();
  document.body.classList.add('listening');
  hudState('listening');
  startMicMeter();
  const r = await window.jarvis.listen();
  stopMicMeter();
  document.body.classList.remove('listening');
  settleState();
  if (r.ok) submit(r.text);
  else {
    $('foot').textContent = r.message;
    setTimeout(resetFoot, 4500);
  }
}
function resetFoot() {
  $('foot').textContent = `Enter execute · Shift+Enter new line · Ctrl+M speak · Esc abort · ${settings.hotkey || ''} summon`;
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
  $('bootAnim').checked = settings.bootAnim !== false;
  $('versionLine').textContent = `Jarvis v${settings.version}`;
  loadVoices();
  resetFoot();
  refreshCoreStatus();
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
      refreshMembank();
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
    bootAnim: $('bootAnim').checked,
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
    t.textContent = `Upgrade v${u.version} ready to install`;
  } else if (u.state === 'downloading') {
    b.classList.remove('hidden');
    btn.classList.add('hidden');
    t.textContent = u.percent != null ? `Downloading upgrade… ${u.percent}%` : `Downloading v${u.version}…`;
  } else if (u.state === 'latest') {
    $('versionLine').textContent = `Jarvis v${u.version} — up to date`;
  } else if (u.state === 'error' || u.state === 'dev') {
    $('versionLine').textContent = `Jarvis v${settings.version} — ${u.message}`;
  } else if (u.state === 'checking') {
    $('versionLine').textContent = `Jarvis v${settings.version} — checking…`;
  }
});

// ---------- boot sequence ----------
function partOfDay() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function greet() {
  $('greeting').textContent = `${partOfDay()}, ${settings.callMe || 'sir'}.`;
  $('emptyHint').textContent = settings.hasApiKey ? 'All systems are online. What can I do for you?' : 'Uplink offline. Add your Anthropic API key in Config to bring me online.';
}
async function boot() {
  const finish = () => {
    document.body.classList.remove('booting');
    pollStats();
  };
  if (settings.bootAnim === false) return finish();
  const lines = [
    ['JARVIS PERSONAL INTELLIGENCE SYSTEM — BUILD ' + settings.version, ''],
    ['INITIALISING NEURAL INTERFACE', 'OK'],
    ['MOUNTING LOCAL FILE SYSTEMS', 'OK'],
    ['ATTACHING POWERSHELL EXECUTION LAYER', 'OK'],
    ['CALIBRATING VOICE SYNTHESIS', 'OK'],
    ['ESTABLISHING SECURE UPLINK', settings.hasApiKey ? 'OK' : 'NO KEY'],
    ['LOADING MEMORY BANK', 'OK'],
    ['ALL SYSTEMS NOMINAL', ''],
  ];
  const box = $('bootLines');
  for (let i = 0; i < lines.length; i++) {
    const [txt, status] = lines[i];
    const div = document.createElement('div');
    const dots = status ? ' ' + '.'.repeat(Math.max(3, 44 - txt.length)) + ' ' : '';
    div.innerHTML = `&gt; ${esc(txt)}${dots}${status ? `<span class="${status === 'OK' ? 'ok' : 'warn'}">${status}</span>` : ''}`;
    box.appendChild(div);
    $('bootBar').style.width = ((i + 1) / lines.length) * 100 + '%';
    await new Promise((r) => setTimeout(r, i === 0 ? 350 : 190));
  }
  await new Promise((r) => setTimeout(r, 450));
  finish();
  if (settings.hasApiKey && settings.speak && document.visibilityState === 'visible') {
    setTimeout(() => speak(`${partOfDay()}, ${settings.callMe || 'sir'}. All systems are online.`), 500);
  }
}

// ---------- misc ----------
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}
async function newChat() {
  await window.jarvis.newChat();
  stopSpeaking();
  current = null;
  tools = {};
  [...log.children].forEach((c) => c.id !== 'empty' && c.remove());
  $('empty').classList.remove('hidden');
  document.body.classList.remove('chatting');
  settleState();
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
$('attach').onclick = async () => addFiles(await window.jarvis.pickFiles());
$('addHiggs').onclick = async () => {
  const r = await window.jarvis.mcpAdd({ preset: 'higgsfield' });
  if (!r.ok) alertBox(r.message);
  else $('srvMsg').textContent = 'Opening Higgsfield sign-in in your browser…';
};
$('showAddServer').onclick = () => $('addServerForm').classList.toggle('hidden');
$('cancelAddServer').onclick = () => $('addServerForm').classList.add('hidden');
$('srvType').onchange = () => {
  const local = $('srvType').value === 'stdio';
  $('srvUrl').classList.toggle('hidden', local);
  $('srvCmd').classList.toggle('hidden', !local);
};
$('addServer').onclick = async () => {
  const type = $('srvType').value;
  const def = { name: $('srvName').value.trim() || 'Server', type };
  if (type === 'http') def.url = $('srvUrl').value.trim();
  else {
    const parts = $('srvCmd').value.trim().match(/"[^"]*"|\S+/g) || [];
    def.command = (parts.shift() || '').replace(/"/g, '');
    def.args = parts.map((p) => p.replace(/^"|"$/g, ''));
  }
  const r = await window.jarvis.mcpAdd(def);
  if (!r.ok) return ($('srvMsg').textContent = r.message);
  $('srvMsg').textContent = type === 'http' ? 'Added — a browser window may open to sign in.' : 'Added — starting it up.';
  $('srvName').value = $('srvUrl').value = $('srvCmd').value = '';
};
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
document.querySelectorAll('.proto').forEach((c) => (c.onclick = () => submit(c.textContent)));
window.jarvis.onFocusInput(() => input.focus());

(async () => {
  settings = await window.jarvis.getSettings();
  fillSettings();
  greet();
  refreshMembank();
  pollStats();
  mcpServers = await window.jarvis.mcpStatus();
  renderServers();
  await boot();
  if (!settings.hasApiKey) openSettings();
  input.focus();
})();
