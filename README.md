# Jarvis

A Claude-powered assistant that lives in your Windows tray and actually does things on your PC: runs PowerShell, opens apps, manages files, reads your screen, clicks and types, searches the web, and remembers what you tell it.

## Install

Download `Jarvis-Setup-x.y.z.exe` from [Releases](https://github.com/tomosmira823-wq/jarvis/releases/latest) and run it. Windows SmartScreen will warn because the installer isn't code-signed: click **More info → Run anyway**.

On first launch, Settings opens. Paste your Anthropic API key (from console.anthropic.com → API keys), press **Test**, then **Save**. The key is encrypted with Windows DPAPI and never leaves your PC except to call the Anthropic API.

## Using it

- **Ctrl+Shift+Space** anywhere shows/hides Jarvis (change it in Settings).
- **Enter** sends, **Esc** stops whatever it's doing, **Ctrl+M** to talk, **Ctrl+N** new chat.
- Closing the window keeps it running in the tray. Quit from the tray icon.
- **Ask before actions** in Settings switches from full control to approving every command, click and keystroke.

## What it can do

| Tool | What it does |
|---|---|
| `run_powershell` | Any PowerShell script as your user (apps, files, settings, winget, git, python…) |
| `read_file` / `write_file` / `list_directory` | File work |
| `open` | URLs, files, folders, apps |
| `screenshot`, `mouse`, `keyboard` | See and drive the GUI |
| `clipboard` | Read/write the clipboard |
| `fetch_url`, `web_search`, `download_file` | The internet |
| `remember` / `forget` | Long-term memory, editable in Settings |

## Attaching files

Drag files onto the window, paste them (Ctrl+V, including screenshots), or use the paperclip. Images and PDFs are sent for Claude to see directly, text and code files are inlined, and anything else (DWG, XLSX, ZIP…) is passed by its path so Jarvis can open it with its tools.

## Connectors (MCP)

Config → Connectors adds apps through MCP, the same standard Claude's own connectors use:

- **+ Higgsfield** adds `https://mcp.higgsfield.ai/mcp` and opens the Higgsfield sign-in in your browser.
- **+ Custom server** takes any remote MCP URL (sign-in handled automatically via OAuth) or a local command (e.g. `npx -y @modelcontextprotocol/server-filesystem C:\Work`).

Connector tools are loaded on demand with Claude's tool search, so even servers with hundreds of tools don't add cost to every message. Sign-in tokens are stored encrypted in `%APPDATA%\Jarvis\mcp-auth.bin`.

## Releasing an update

Bump the version in `package.json` and push to `main`. GitHub Actions builds the installer and publishes the release; every installed copy downloads it in the background and installs it on next restart (or straight away from the "Restart now" banner).

```
npm version patch --no-git-tag-version   # 1.0.0 -> 1.0.1
git commit -am "v1.0.1" && git push
```

## Developing

```
npm install
npm start
```

Data lives in `%APPDATA%\Jarvis` (`settings.json`, `memory.json`, logs).
