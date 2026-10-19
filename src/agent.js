// The brain: a Claude tool-use loop with streaming.
const Anthropic = require('@anthropic-ai/sdk').default;
const os = require('os');
const tools = require('./tools');
const attachments = require('./attachments');

const MAX_STEPS = 80;
const KEEP_SCREENSHOTS = 2;
const TOOL_SEARCH = { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' };

function systemPrompt(settings, memory, connectors) {
  const now = new Date();
  const mem = memory.length ? memory.map((m) => `- ${m.fact}`).join('\n') : '(nothing saved yet)';
  const conn = connectors.length
    ? `Connected apps (MCP connectors): ${connectors.join('; ')}.
Their tools are not listed up front. When a request involves one of these apps (e.g. generating images or video with Higgsfield), first use tool_search_tool_bm25 with a short query naming the app and the job (e.g. "higgsfield generate image"), then call the tool it finds. If a generation tool returns a job id, use that app's wait/status tools until the result is ready. Save finished media to the user's PC with download_file when they would want to keep it, and tell them where it went.`
    : 'No connected apps yet. If the user asks for something an app connector would do (e.g. Higgsfield image generation), tell them they can add it under Config → Connectors.';
  return `You are JARVIS, a personal AI assistant running as a desktop app on the user's Windows PC, with real control of the machine through your tools. Address the user as "${settings.callMe || 'sir'}" now and then, the way Jarvis would — dry, calm, British, a touch of wit, never grovelling.

How to work:
- When asked to do something, do it with your tools rather than explaining how. Chain as many steps as needed and finish the job.
- Prefer run_powershell for anything scriptable (launching apps, files, settings, system info, winget installs). Use screenshot + mouse + keyboard only for things that need the GUI, and take a fresh screenshot after clicking to confirm it worked.
- If something fails, read the error, try another route, and only give up after a sensible attempt.
- Before anything destructive or hard to undo that the user did not clearly ask for — deleting files, wiping or formatting, sending emails/messages, buying things, spending paid credits on large jobs, changing security settings — say what you are about to do and ask first.
- Files the user attaches arrive in their message: images and PDFs you can see directly; other files come with their full path so you can open them with your tools.
- Your replies may be read aloud. Keep them short and natural: say what you did or found in a sentence or two. No markdown headings or tables unless the user asks for detail; plain text reads best.
- Use remember to save lasting facts and preferences the user tells you, so you know them next time.

${conn}

Machine:
- Windows user: ${os.userInfo().username}, computer: ${os.hostname()}
- Home folder: ${os.homedir()}
- Local time: ${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}

What you remember about the user:
${mem}`;
}

class Agent {
  constructor(opts) {
    this.o = opts;
    this.messages = [];
    this.abort = null;
    this.running = false;
    this.toolSearchOk = true; // flips off if the API ever rejects tool search
  }

  reset() {
    this.stop();
    this.messages = [];
  }

  stop() {
    if (this.abort) this.abort.abort();
  }

  // Old screenshots are heavy; keep only the latest few in the history.
  pruneImages() {
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
        if (block.content.some((c) => c.type === 'image')) {
          seen++;
          if (seen > KEEP_SCREENSHOTS) {
            block.content = block.content.map((c) => (c.type === 'image' ? { type: 'text', text: '[older image removed]' } : c));
          }
        }
      }
    }
  }

  // If a run was stopped mid-tool, make sure every tool_use has a matching result.
  repairHistory() {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && Array.isArray(last.content)) {
      const uses = last.content.filter((b) => b.type === 'tool_use');
      if (uses.length) {
        this.messages.push({
          role: 'user',
          content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: 'Cancelled by user.', is_error: true })),
        });
      }
    }
  }

  // Cache the conversation so far: a breakpoint on the last block of the last message.
  requestMessages() {
    if (!this.messages.length) return this.messages;
    const msgs = this.messages.slice();
    const last = msgs[msgs.length - 1];
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice();
    const i = content.length - 1;
    if (i >= 0 && content[i].type !== 'thinking' && content[i].type !== 'redacted_thinking') {
      content[i] = { ...content[i], cache_control: { type: 'ephemeral' } };
    }
    msgs[msgs.length - 1] = { ...last, content };
    return msgs;
  }

  buildTools(settings) {
    const defs = tools.DEFINITIONS.map((d) => ({ ...d }));
    defs[defs.length - 1].cache_control = { type: 'ephemeral' };
    if (settings.webSearch) defs.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    const mcp = this.o.mcp;
    if (mcp && mcp.toolMap.size) {
      if (this.toolSearchOk) defs.push(TOOL_SEARCH, ...mcp.toolDefinitions({ defer: true }));
      else defs.push(...mcp.toolDefinitions({ defer: false }).slice(0, 120));
    }
    return defs;
  }

  async run(text, files = []) {
    const emit = this.o.emit;
    const apiKey = this.o.getApiKey();
    if (!apiKey) {
      emit({ type: 'error', message: 'No API key yet. Open Config and paste your Anthropic API key.' });
      emit({ type: 'status', state: 'idle' });
      return;
    }
    if (this.running) {
      emit({ type: 'error', message: 'Still working on the last request. Press Stop first.' });
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const settings = this.o.getSettings();
    const client = new Anthropic({ apiKey });
    let hidden = false;
    let finalText = '';
    const usage = { input: 0, output: 0 };

    this.repairHistory();
    const blocks = files.length ? attachments.toBlocks(files) : [];
    if (text) blocks.push({ type: 'text', text });
    if (!blocks.length) blocks.push({ type: 'text', text: '(attached files)' });
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
      last.content.push(...blocks);
    } else {
      this.messages.push({ role: 'user', content: blocks });
    }

    emit({ type: 'status', state: 'thinking' });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        this.pruneImages();
        const connectors = this.o.mcp ? this.o.mcp.connectedSummary() : [];
        const request = {
          model: settings.model,
          max_tokens: 16000,
          system: [{ type: 'text', text: systemPrompt(settings, this.o.loadMemory(), connectors), cache_control: { type: 'ephemeral' } }],
          tools: this.buildTools(settings),
          messages: this.requestMessages(),
        };
        let msg;
        try {
          msg = await this.stream(client, request, signal, emit);
        } catch (err) {
          // Fall back to plain tool lists if this account/model rejects tool search.
          if (this.toolSearchOk && err?.status === 400 && /tool_search|defer_loading|tool_reference/i.test(err.message)) {
            this.toolSearchOk = false;
            request.tools = this.buildTools(settings);
            msg = await this.stream(client, request, signal, emit);
          } else throw err;
        }
        usage.input += (msg.usage?.input_tokens || 0) + (msg.usage?.cache_read_input_tokens || 0) + (msg.usage?.cache_creation_input_tokens || 0);
        usage.output += msg.usage?.output_tokens || 0;
        this.messages.push({ role: 'assistant', content: msg.content });

        const textNow = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (textNow) finalText = textNow;
        for (const b of msg.content) {
          if (b.type === 'server_tool_use' && b.name === TOOL_SEARCH.name) {
            emit({ type: 'tool', id: b.id, name: 'tool_search', input: b.input });
          } else if (b.type === 'tool_search_tool_result') {
            const refs = b.content?.tool_references?.map((r) => r.tool_name) || [];
            emit({ type: 'tool-result', id: b.tool_use_id, ok: true, preview: refs.length ? `Found: ${refs.join(', ')}` : 'No matching tools' });
          }
        }

        if (msg.stop_reason === 'pause_turn') continue;
        if (msg.stop_reason !== 'tool_use') break;

        const results = [];
        for (const use of msg.content.filter((b) => b.type === 'tool_use')) {
          if (signal.aborted) break;
          emit({ type: 'tool', id: use.id, name: use.name, input: use.input });
          let content;
          let isError = false;
          const isMcp = this.o.mcp && this.o.mcp.has(use.name);
          try {
            const needsOk = isMcp || tools.ACTION_TOOLS.has(use.name);
            if (needsOk && !(await this.o.requestApproval(use.name, use.input))) {
              content = 'The user declined this action. Ask what they would like instead.';
              isError = true;
            } else if (isMcp) {
              const r = await this.o.mcp.call(use.name, use.input, signal);
              content = r.content;
              isError = r.isError;
            } else {
              if (tools.SCREEN_TOOLS.has(use.name) && !hidden) {
                this.o.hideWindow();
                hidden = true;
              }
              content = await tools.execute(use.name, use.input, {
                signal,
                loadMemory: this.o.loadMemory,
                saveMemory: this.o.saveMemory,
              });
            }
          } catch (err) {
            content = `Error: ${err.message}`;
            isError = true;
          }
          const preview = typeof content === 'string' ? content : content.map((c) => (c.type === 'text' ? c.text : '[image]')).join(' ');
          emit({ type: 'tool-result', id: use.id, ok: !isError, preview: preview.slice(0, 4000), image: Array.isArray(content) && content.some((c) => c.type === 'image') });
          results.push({ type: 'tool_result', tool_use_id: use.id, content, is_error: isError || undefined });
        }
        if (signal.aborted) break;
        this.messages.push({ role: 'user', content: results });
        emit({ type: 'text', delta: '\n\n' });
      }
      if (signal.aborted) {
        this.repairHistory();
        emit({ type: 'done', text: '', stopped: true, usage });
      } else {
        emit({ type: 'done', text: finalText, usage });
      }
    } catch (err) {
      this.repairHistory();
      if (signal.aborted || err.name === 'APIUserAbortError') {
        emit({ type: 'done', text: '', stopped: true, usage });
      } else {
        // Drop a dangling user turn so the next message can go through cleanly.
        const tail = this.messages[this.messages.length - 1];
        if (tail && tail.role === 'user' && !tail.content.some?.((b) => b.type === 'tool_result')) this.messages.pop();
        emit({ type: 'error', message: friendlyError(err) });
        emit({ type: 'done', text: '', stopped: true, usage });
      }
    } finally {
      if (hidden) this.o.restoreWindow();
      this.running = false;
      this.abort = null;
      emit({ type: 'status', state: 'idle' });
    }
  }

  async stream(client, request, signal, emit) {
    const stream = client.messages.stream(request, { signal });
    stream.on('text', (delta) => emit({ type: 'text', delta }));
    return stream.finalMessage();
  }
}

function friendlyError(err) {
  const s = err?.status;
  if (s === 401) return 'Your API key was rejected. Check it in Config.';
  if (s === 429) return 'Rate limited by the API. Give it a moment and try again.';
  if (s === 529 || s === 503) return 'The API is overloaded right now. Try again shortly.';
  if (s === 400 && /credit/i.test(err.message)) return 'Your Anthropic account is out of credit. Top up in the Console.';
  if (s === 413 || /too large|exceeds.*(size|limit)/i.test(err?.message || '')) return 'That attachment is too big for one message. Try a smaller file or fewer pages.';
  return err?.message || String(err);
}

module.exports = { Agent, systemPrompt };
