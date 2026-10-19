// The brain: a Claude tool-use loop with streaming.
const Anthropic = require('@anthropic-ai/sdk').default;
const os = require('os');
const tools = require('./tools');

const MAX_STEPS = 60;
const KEEP_SCREENSHOTS = 2;

function systemPrompt(settings, memory) {
  const now = new Date();
  const mem = memory.length
    ? memory.map((m) => `- ${m.fact}`).join('\n')
    : '(nothing saved yet)';
  return `You are JARVIS, a personal AI assistant running as a desktop app on the user's Windows PC, with real control of the machine through your tools. Address the user as "${settings.callMe || 'sir'}" now and then, the way Jarvis would — dry, calm, British, a touch of wit, never grovelling.

How to work:
- When asked to do something, do it with your tools rather than explaining how. Chain as many steps as needed and finish the job.
- Prefer run_powershell for anything scriptable (launching apps, files, settings, system info, winget installs). Use screenshot + mouse + keyboard only for things that need the GUI, and take a fresh screenshot after clicking to confirm it worked.
- If something fails, read the error, try another route, and only give up after a sensible attempt.
- Before anything destructive or hard to undo that the user did not clearly ask for — deleting files, wiping or formatting, sending emails/messages, buying things, changing security settings — say what you are about to do and ask first.
- Your replies may be read aloud. Keep them short and natural: say what you did or found in a sentence or two. No markdown headings or tables unless the user asks for detail; plain text reads best.
- Use remember to save lasting facts and preferences the user tells you, so you know them next time.

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
            block.content = block.content.map((c) =>
              c.type === 'image' ? { type: 'text', text: '[older screenshot removed]' } : c
            );
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

  async run(text) {
    const emit = this.o.emit;
    const apiKey = this.o.getApiKey();
    if (!apiKey) {
      emit({ type: 'error', message: 'No API key yet. Open Settings and paste your Anthropic API key.' });
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
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
      last.content.push({ type: 'text', text });
    } else {
      this.messages.push({ role: 'user', content: text });
    }

    const toolDefs = [...tools.DEFINITIONS];
    if (settings.webSearch) toolDefs.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });

    emit({ type: 'status', state: 'thinking' });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        this.pruneImages();
        const stream = client.messages.stream(
          {
            model: settings.model,
            max_tokens: 8192,
            system: [{ type: 'text', text: systemPrompt(settings, this.o.loadMemory()), cache_control: { type: 'ephemeral' } }],
            tools: toolDefs,
            messages: this.messages,
          },
          { signal }
        );
        stream.on('text', (delta) => emit({ type: 'text', delta }));
        const msg = await stream.finalMessage();
        usage.input += msg.usage?.input_tokens || 0;
        usage.output += msg.usage?.output_tokens || 0;
        this.messages.push({ role: 'assistant', content: msg.content });

        const textNow = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (textNow) finalText = textNow;

        if (msg.stop_reason === 'pause_turn') continue;
        if (msg.stop_reason !== 'tool_use') break;

        const results = [];
        for (const use of msg.content.filter((b) => b.type === 'tool_use')) {
          if (signal.aborted) break;
          emit({ type: 'tool', id: use.id, name: use.name, input: use.input });
          let content;
          let isError = false;
          try {
            if (tools.ACTION_TOOLS.has(use.name) && !(await this.o.requestApproval(use.name, use.input))) {
              content = 'The user declined this action. Ask what they would like instead.';
              isError = true;
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
          emit({ type: 'tool-result', id: use.id, ok: !isError, preview: preview.slice(0, 4000), image: Array.isArray(content) });
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
        if (tail && tail.role === 'user' && typeof tail.content === 'string') this.messages.pop();
        emit({ type: 'error', message: friendlyError(err) });
      }
    } finally {
      if (hidden) this.o.restoreWindow();
      this.running = false;
      this.abort = null;
      emit({ type: 'status', state: 'idle' });
    }
  }
}

function friendlyError(err) {
  const s = err?.status;
  if (s === 401) return 'Your API key was rejected. Check it in Settings.';
  if (s === 429) return 'Rate limited by the API. Give it a moment and try again.';
  if (s === 529 || s === 503) return 'The API is overloaded right now. Try again shortly.';
  if (s === 400 && /credit/i.test(err.message)) return 'Your Anthropic account is out of credit. Top up in the Console.';
  return err?.message || String(err);
}

module.exports = { Agent, systemPrompt };
