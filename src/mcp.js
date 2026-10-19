// MCP client manager: connects Jarvis to remote (HTTP, with OAuth sign-in) and
// local (stdio) MCP servers and exposes their tools to Claude.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

const CALLBACK_PORT = 47823;
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TEXT = 30000;

const PRESETS = {
  higgsfield: { name: 'Higgsfield', type: 'http', url: 'https://mcp.higgsfield.ai/mcp' },
};

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'server';
}

// ---------- OAuth callback listener (one sign-in at a time) ----------
let pendingAuth = null; // { state, resolve, reject, timer }
let callbackServers = [];

const DONE_PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>Jarvis</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#02060a;color:#d6f4ff;font:16px Segoe UI,sans-serif">
<div style="text-align:center"><div style="width:70px;height:70px;margin:0 auto 22px;border-radius:50%;border:2px solid ${ok ? '#5fdcff' : '#ff4f5e'};box-shadow:0 0 30px ${ok ? '#5fdcff' : '#ff4f5e'}"></div>
<div style="letter-spacing:.3em;font-weight:600;color:${ok ? '#5fdcff' : '#ff4f5e'}">${ok ? 'CONNECTED' : 'SIGN-IN FAILED'}</div>
<p style="color:#7fa9bb">${msg}</p></div></body>`;

function handleCallback(req, res) {
  const u = new URL(req.url, REDIRECT_URL);
  if (u.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const err = u.searchParams.get('error_description') || u.searchParams.get('error');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (!pendingAuth) {
    res.end(DONE_PAGE(false, 'Jarvis was not expecting a sign-in. Try again from Jarvis.'));
    return;
  }
  if (err || !code) {
    res.end(DONE_PAGE(false, err || 'No authorisation code was returned.'));
    pendingAuth.reject(new Error(err || 'No authorisation code returned'));
  } else if (pendingAuth.state && state && state !== pendingAuth.state) {
    res.end(DONE_PAGE(false, 'Security check failed (state mismatch).'));
    pendingAuth.reject(new Error('OAuth state mismatch'));
  } else {
    res.end(DONE_PAGE(true, 'You can close this tab and go back to Jarvis.'));
    pendingAuth.resolve(code);
  }
}

async function ensureCallbackServer() {
  if (callbackServers.length) return;
  const listen = (host) =>
    new Promise((resolve) => {
      const s = http.createServer(handleCallback);
      s.once('error', () => resolve(null));
      s.listen(CALLBACK_PORT, host, () => resolve(s));
    });
  // "localhost" may resolve to IPv4 or IPv6 in the browser, so listen on both loopbacks.
  callbackServers = (await Promise.all([listen('127.0.0.1'), listen('::1')])).filter(Boolean);
  if (!callbackServers.length) throw new Error(`Port ${CALLBACK_PORT} is busy, so the sign-in callback can't be received.`);
}

function waitForCode(state) {
  if (pendingAuth) pendingAuth.reject(new Error('Superseded by a newer sign-in'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAuth = null;
      reject(new Error('Sign-in timed out.'));
    }, AUTH_TIMEOUT_MS);
    const done = (fn) => (v) => {
      clearTimeout(timer);
      pendingAuth = null;
      fn(v);
    };
    pendingAuth = { state, resolve: done(resolve), reject: done(reject) };
  });
}

// ---------- token storage ----------
class AuthStore {
  constructor(file, encrypt, decrypt) {
    this.file = file;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.data = {};
    try {
      this.data = JSON.parse(decrypt(fs.readFileSync(file, 'utf8')));
    } catch {}
  }
  get(id) {
    return (this.data[id] ||= {});
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.encrypt(JSON.stringify(this.data)));
  }
  clear(id) {
    delete this.data[id];
    this.save();
  }
}

class Provider {
  constructor(store, id, openExternal) {
    this.store = store;
    this.id = id;
    this.openExternal = openExternal;
    this.interactive = false;
    this.authUrl = null;
    this._state = crypto.randomBytes(16).toString('hex');
  }
  get rec() {
    return this.store.get(this.id);
  }
  get redirectUrl() {
    return REDIRECT_URL;
  }
  get clientMetadata() {
    return {
      client_name: 'Jarvis',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return this._state;
  }
  clientInformation() {
    return this.rec.client;
  }
  saveClientInformation(info) {
    this.rec.client = info;
    this.store.save();
  }
  tokens() {
    return this.rec.tokens;
  }
  saveTokens(t) {
    this.rec.tokens = t;
    this.store.save();
  }
  saveCodeVerifier(v) {
    this.rec.verifier = v;
    this.store.save();
  }
  codeVerifier() {
    if (!this.rec.verifier) throw new Error('No PKCE verifier saved');
    return this.rec.verifier;
  }
  invalidateCredentials(scope) {
    const r = this.rec;
    if (scope === 'all') {
      delete r.client;
      delete r.tokens;
      delete r.verifier;
    } else if (scope === 'client') delete r.client;
    else if (scope === 'tokens') delete r.tokens;
    else if (scope === 'verifier') delete r.verifier;
    this.store.save();
  }
  async redirectToAuthorization(url) {
    this.authUrl = url;
    if (this.interactive) await this.openExternal(url.toString());
  }
}

// ---------- manager ----------
class McpManager {
  constructor({ userDir, encrypt, decrypt, openExternal, onChange, log }) {
    this.configFile = path.join(userDir, 'mcp.json');
    this.authStore = new AuthStore(path.join(userDir, 'mcp-auth.bin'), encrypt, decrypt);
    this.openExternal = openExternal;
    this.onChange = onChange || (() => {});
    this.log = log || console;
    this.servers = this.loadConfig();
    this.live = {}; // id -> { status, error, tools, client, transport }
    this.toolMap = new Map(); // claude tool name -> { id, tool }
  }

  loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      return [];
    }
  }
  saveConfig() {
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify(this.servers, null, 2));
  }

  setLive(id, patch) {
    this.live[id] = { ...(this.live[id] || { status: 'disconnected', tools: [] }), ...patch };
    this.rebuildToolMap();
    this.onChange(this.status());
  }

  status() {
    return this.servers.map((s) => {
      const l = this.live[s.id] || {};
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        url: s.url,
        command: s.command,
        args: s.args,
        enabled: s.enabled !== false,
        status: s.enabled === false ? 'disabled' : l.status || 'disconnected',
        error: l.error || '',
        toolCount: (l.tools || []).length,
      };
    });
  }

  add(def) {
    const base = def.preset ? PRESETS[def.preset] : def;
    if (!base) throw new Error('Unknown preset');
    const s = {
      id: crypto.randomBytes(6).toString('hex'),
      name: (base.name || 'Server').trim(),
      type: base.type === 'stdio' ? 'stdio' : 'http',
      url: base.url ? String(base.url).trim() : undefined,
      command: base.command ? String(base.command).trim() : undefined,
      args: Array.isArray(base.args) ? base.args : base.args ? splitArgs(base.args) : [],
      env: base.env || {},
      enabled: true,
    };
    if (s.type === 'http') {
      try {
        new URL(s.url);
      } catch {
        throw new Error('That URL is not valid.');
      }
    } else if (!s.command) throw new Error('A command is required for a local server.');
    this.servers.push(s);
    this.saveConfig();
    this.onChange(this.status());
    return s;
  }

  async remove(id) {
    await this.disconnect(id);
    this.servers = this.servers.filter((s) => s.id !== id);
    delete this.live[id];
    this.authStore.clear(id);
    this.saveConfig();
    this.rebuildToolMap();
    this.onChange(this.status());
  }

  async setEnabled(id, enabled) {
    const s = this.servers.find((x) => x.id === id);
    if (!s) return;
    s.enabled = enabled;
    this.saveConfig();
    if (enabled) await this.connect(id);
    else await this.disconnect(id);
    this.onChange(this.status());
  }

  async signOut(id) {
    await this.disconnect(id);
    this.authStore.clear(id);
    this.setLive(id, { status: 'needs-auth', error: '' });
  }

  async connectAll() {
    await Promise.all(this.servers.filter((s) => s.enabled !== false).map((s) => this.connect(s.id).catch(() => {})));
  }

  async disconnect(id) {
    const l = this.live[id];
    if (l && l.client) {
      try {
        await l.client.close();
      } catch {}
    }
    if (l) this.setLive(id, { status: 'disconnected', client: null, transport: null, tools: [] });
  }

  // interactive = the user clicked Connect/Sign in, so a browser sign-in may open.
  async connect(id, { interactive = false } = {}) {
    const s = this.servers.find((x) => x.id === id);
    if (!s) throw new Error('No such server');
    await this.disconnect(id);
    this.setLive(id, { status: 'connecting', error: '' });
    try {
      if (s.type === 'stdio') await this.connectStdio(s);
      else await this.connectHttp(s, interactive);
    } catch (err) {
      const needsAuth = err instanceof UnauthorizedError || /unauthori[sz]ed|401/i.test(err.message);
      this.setLive(id, {
        status: needsAuth ? 'needs-auth' : 'error',
        error: needsAuth ? 'Sign-in required' : err.message,
        client: null,
        tools: [],
      });
      this.log.warn(`MCP ${s.name}:`, err.message);
      if (interactive) throw err;
    }
  }

  async finishConnect(s, client, transport) {
    const tools = [];
    let cursor;
    do {
      const r = await client.listTools(cursor ? { cursor } : {});
      tools.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor && tools.length < 2000);
    transport.onclose = () => {
      if (this.live[s.id]?.client === client) this.setLive(s.id, { status: 'disconnected', client: null, tools: [] });
    };
    this.setLive(s.id, { status: 'connected', error: '', client, transport, tools });
  }

  newClient() {
    return new Client({ name: 'Jarvis', version: '1.2.0' }, { capabilities: {} });
  }

  async connectStdio(s) {
    const transport = new StdioClientTransport({
      command: s.command,
      args: s.args || [],
      env: { ...getDefaultEnvironment(), ...(s.env || {}) },
      stderr: 'pipe',
    });
    const client = this.newClient();
    await client.connect(transport);
    await this.finishConnect(s, client, transport);
  }

  async connectHttp(s, interactive) {
    const url = new URL(s.url);
    const provider = new Provider(this.authStore, s.id, this.openExternal);
    provider.interactive = interactive;
    if (interactive) await ensureCallbackServer();

    let lastTransport = null;
    const attempt = async (Kind) => {
      const transport = new Kind(url, { authProvider: provider });
      lastTransport = transport;
      const client = this.newClient();
      await client.connect(transport);
      return { client, transport };
    };

    // Start listening for the redirect before the browser can possibly come back.
    const codeP = interactive ? waitForCode(provider.state()) : null;
    codeP?.catch(() => {});
    try {
      let Kind = StreamableHTTPClientTransport;
      let conn;
      try {
        conn = await attempt(Kind);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          if (!interactive) throw err;
          // The provider has opened the browser; wait for the redirect back.
          const code = await codeP;
          await lastTransport.finishAuth(code);
          provider.interactive = false;
          conn = await attempt(Kind);
        } else if (/40[45]|not found|method not allowed/i.test(err.message)) {
          // Older servers only speak SSE.
          Kind = SSEClientTransport;
          try {
            conn = await attempt(Kind);
          } catch (err2) {
            if (!(err2 instanceof UnauthorizedError) || !interactive) throw err2;
            const code = await codeP;
            await lastTransport.finishAuth(code);
            provider.interactive = false;
            conn = await attempt(Kind);
          }
        } else throw err;
      }
      await this.finishConnect(s, conn.client, conn.transport);
    } finally {
      if (interactive && pendingAuth) pendingAuth.reject(new Error('cancelled'));
    }
  }

  rebuildToolMap() {
    this.toolMap.clear();
    for (const s of this.servers) {
      const l = this.live[s.id];
      if (!l || l.status !== 'connected') continue;
      const prefix = `mcp_${slug(s.name)}__`;
      for (const t of l.tools || []) {
        let name = (prefix + t.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        let n = 2;
        while (this.toolMap.has(name)) name = name.slice(0, 60) + '_' + n++;
        this.toolMap.set(name, { id: s.id, server: s.name, tool: t });
      }
    }
  }

  // Tool definitions for Claude. MCP tools are deferred: Claude finds them
  // with tool search, so huge servers don't bloat every request.
  toolDefinitions({ defer = true } = {}) {
    const defs = [];
    for (const [name, { server, tool }] of this.toolMap) {
      const schema = tool.inputSchema && tool.inputSchema.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
      const def = {
        name,
        description: `[${server}] ${(tool.description || tool.title || tool.name).slice(0, 1000)}`,
        input_schema: schema,
      };
      if (defer) def.defer_loading = true;
      defs.push(def);
    }
    return defs;
  }

  connectedSummary() {
    return this.servers
      .filter((s) => this.live[s.id]?.status === 'connected')
      .map((s) => `${s.name} (${this.live[s.id].tools.length} tools, prefix mcp_${slug(s.name)}__)`);
  }

  has(name) {
    return this.toolMap.has(name);
  }

  async call(name, input, signal) {
    const entry = this.toolMap.get(name);
    if (!entry) throw new Error(`MCP tool ${name} is not connected any more.`);
    const l = this.live[entry.id];
    if (!l || !l.client) throw new Error(`${entry.server} is not connected.`);
    const r = await l.client.callTool({ name: entry.tool.name, arguments: input || {} }, undefined, {
      signal,
      timeout: 10 * 60 * 1000,
      resetTimeoutOnProgress: true,
    });
    return { content: toClaudeContent(r), isError: !!r.isError };
  }
}

function splitArgs(s) {
  const out = [];
  String(s).replace(/"([^"]*)"|'([^']*)'|(\S+)/g, (_, a, b, c) => out.push(a ?? b ?? c));
  return out;
}

const IMG_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function toClaudeContent(r) {
  const out = [];
  const text = (t) => out.push({ type: 'text', text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\n…[truncated]' : t });
  for (const c of r.content || []) {
    if (c.type === 'text') text(c.text);
    else if (c.type === 'image' && IMG_TYPES.has(c.mimeType)) out.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } });
    else if (c.type === 'image') text(`[image of type ${c.mimeType} not shown]`);
    else if (c.type === 'audio') text(`[audio ${c.mimeType}]`);
    else if (c.type === 'resource_link') text(`Resource: ${c.name || ''} ${c.uri}`.trim());
    else if (c.type === 'resource') {
      const res = c.resource || {};
      if (res.text != null) text(`${res.uri || ''}\n${res.text}`);
      else text(`[binary resource ${res.uri || ''} ${res.mimeType || ''}]`);
    }
  }
  if (!out.length && r.structuredContent) text(JSON.stringify(r.structuredContent, null, 2));
  if (!out.length) text('(no output)');
  return out;
}

module.exports = { McpManager, PRESETS, toClaudeContent, splitArgs, REDIRECT_URL };
