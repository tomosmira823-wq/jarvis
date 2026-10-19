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
| `fetch_url`, `web_search` | The internet |
| `remember` / `forget` | Long-term memory, editable in Settings |

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
