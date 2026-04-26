# Setup Guide

End-to-end setup for the Quest Data Modeler demo agent. Tested on macOS; equivalent steps for Windows 10/11 and a fresh Ubuntu VM are noted inline.

---

## 1. Prerequisites

Install once per machine:

| Tool | Version | Notes |
| --- | --- | --- |
| **Node.js** | 18+ | <https://nodejs.org/en/download> |
| **Python** | 3.10+ | <https://www.python.org/downloads/> · on Windows tick "Add Python to PATH" during install |
| **Git** | any | <https://git-scm.com/downloads> |

Verify:

```bash
node --version    # v18 or higher
python --version  # 3.10 or higher (try `python3` on macOS/Linux)
npm --version
```

---

## 2. Clone & install

```bash
git clone <your-repo-url> demo-agent
cd demo-agent

# Node deps (Playwright + ts-node + commander)
npm install

# Browser binaries (Chromium only)
npx playwright install chromium

# Python deps for the video pipeline
pip install -r output/requirements.txt
```

> **Windows note** — if `pip` complains about long paths, run PowerShell as admin and execute `git config --system core.longpaths true` before cloning.

---

## 3. Authentication profile (`.qdm-profile/`)

Quest uses Mart Portal SSO. The flow runner reuses a Playwright persistent profile so SSO cookies survive between runs.

Create the profile by running a one-time auto-login. The credentials are passed via env vars.

**macOS / Linux:**
```bash
QDM_USER=adminuser QDM_PASS=Erwin123 npx tsx scripts/auto-login.ts
```

**Windows PowerShell:**
```powershell
$env:QDM_USER="adminuser"; $env:QDM_PASS="Erwin123"
npx tsx scripts/auto-login.ts
```

**Windows cmd.exe:**
```cmd
set QDM_USER=adminuser
set QDM_PASS=Erwin123
npx tsx scripts/auto-login.ts
```

This creates `.qdm-profile/` in the project root. SSO cookies expire after a few hours — re-run the same command whenever a flow fails with "auth: login screen detected."

> Cross-shell shortcut: `npm install --save-dev cross-env`, then prefix any command with `npx cross-env QDM_USER=adminuser QDM_PASS=Erwin123 ...`. Works identically on every OS.

---

## 4. Run a demo

Two-step pipeline: **flow runner** records screenshots, **video builder** turns them into a narrated MP4.

### 4a. Run the flow

```bash
QDM_USER=adminuser QDM_PASS=Erwin123 \
  npm run demo -- --flow=realQuest_ai_features --headless
```

(Use the env-var syntax from §3 on Windows.)

Flags:
- `--flow=<name>` — flow JSON in `flows/`. Drop the `.json`.
- `--headless` — recommended for unattended runs. Omit to watch in a real browser.
- `--viewport 1440x900` — viewport size (default).
- `--slow-mo 150` — ms delay between actions (default).
- `--profile <dir>` — alternative profile directory.

Output goes to `output/<flow-name>_<timestamp>/`:
- `screenshots/` — one PNG per step
- `steps.json` — manifest with timing + result for every step

### 4b. Build the narrated video

```bash
npm run video -- --narrate --engine edge --voice en-US-AvaMultilingualNeural
```

With no run-dir argument the builder picks the most recent `output/<run-dir>`. To target a specific run:

```bash
npm run video -- output/quest_data_modeler_ai_features_showcase_2026-04-26T12-23-49-048Z \
  --narrate --engine edge --voice en-US-AvaMultilingualNeural
```

Useful flags:
- `--engine edge` — neural TTS (recommended). The default `say` engine is macOS-only and sounds robotic.
- `--voice <name>` — any voice from `python -m edge_tts --list-voices`. Good defaults:
  - `en-US-AvaMultilingualNeural` — warm, conversational (current default in our flows)
  - `en-US-AndrewMultilingualNeural` — male, confident
  - `en-US-EmmaMultilingualNeural` — cheerful, clear
  - `en-US-ChristopherNeural` — authoritative, news tone
- `--step-seconds 5` — override per-step duration (default uses narration length)
- `--cover-seconds 4` — cover slide hold time
- `--skip-cover` / `--skip-outro` — omit the title/closing slides

Final video lands at `output/<run-dir>/demo.mp4`.

---

## 5. Author a new flow

Drop a new JSON file into `flows/`, e.g. `flows/myDemo.json`:

```json
{
  "flow_name": "My Demo",
  "base_url": "http://questpmdmc.myerwin.com/overview",
  "cover_narration": "What this demo shows...",
  "outro_narration": "Wrap-up narration...",
  "steps": [
    { "action": "wait", "selector": "text=Welcome back", "label": "Sign in", "narration": "...", "timeoutMs": 60000 },
    { "action": "click", "selector": "button:has-text(\"Click here to get started\")", "label": "...", "narration": "..." }
  ]
}
```

Supported actions:

| Action | Required fields | Notes |
| --- | --- | --- |
| `goto` | `url` | Navigate the browser. |
| `click` | `selector` | Add `"force": true` to bypass MUI backdrops. |
| `clickAt` | `selector`, `x`, `y` | Click at offset relative to the located element's box. Use `selector: "body"` for absolute coords. |
| `dblclick` | `selector` | Same `force` option. Used to open models from the Recent list. |
| `drag` | `selector`, `x`, `y`, `toX`, `toY` | Optional `steps` for smoother motion. |
| `type` | `selector`, `value` | Fills inputs/textareas. |
| `press` | `value` (key name) | Optional `selector`. |
| `setFile` | `selector`, `value` | Upload a file via hidden `<input type="file">`. |
| `wait` | one of `selector` (waits for visible) or `delayMs` (waits in ms) | |
| `waitForCanvas` | optional `selector` | Waits for `networkidle` then a default canvas-render delay. |
| `manualPause` | — | Blocks until a sentinel file exists. See §7. |
| `screenshot` | — | Forces an extra capture point (every step is captured already). |

Per-step `narration` overrides the auto-caption. Use `""` for silence during that step.

Run with `npm run demo -- --flow=myDemo --headless`.

---

## 6. Schedule it

### macOS / Linux — cron
```cron
0 9 * * 1  cd /path/to/demo-agent && \
            QDM_USER=adminuser QDM_PASS=Erwin123 \
            npm run demo -- --flow=realQuest_ai_features --headless && \
            npm run video -- --narrate --engine edge --voice en-US-AvaMultilingualNeural
```

### Windows — Task Scheduler
- **Action:** Start a program
- **Program:** `cmd.exe`
- **Arguments:**
  ```
  /c cd /d C:\path\to\demo-agent && set QDM_USER=adminuser&& set QDM_PASS=Erwin123&& npm run demo -- --flow=realQuest_ai_features --headless && npm run video -- --narrate --engine edge --voice en-US-AvaMultilingualNeural
  ```
  *(Note the `&&` joins — no leading spaces around them, otherwise the shell appends a space to the variable.)*

### One-click on Windows — `run-demo.bat`
Save this in the project root and double-click:
```bat
@echo off
set QDM_USER=adminuser
set QDM_PASS=Erwin123
call npm run demo -- --flow=realQuest_ai_features --headless || goto :err
call npm run video -- --narrate --engine edge --voice en-US-AvaMultilingualNeural || goto :err
echo.
echo Done. Video: output\<latest-run>\demo.mp4
pause
exit /b 0
:err
echo.
echo FAILED. See log above.
pause
exit /b 1
```

### CI (GitHub Actions sketch)
```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- uses: actions/setup-python@v5
  with: { python-version: '3.11' }
- run: npm ci
- run: npx playwright install chromium
- run: pip install -r output/requirements.txt
- env:
    QDM_USER: ${{ secrets.QDM_USER }}
    QDM_PASS: ${{ secrets.QDM_PASS }}
  run: |
    npm run demo -- --flow=realQuest_ai_features --headless
    npm run video -- --narrate --engine edge --voice en-US-AvaMultilingualNeural
- uses: actions/upload-artifact@v4
  with:
    name: demo-video
    path: output/**/demo.mp4
```

---

## 7. `manualPause` on Windows

The `manualPause` action waits for a sentinel file. Default location is `/tmp/qdm-continue`, which doesn't exist on Windows. Override before running:

**PowerShell:**
```powershell
$env:QDM_PAUSE_FILE = "C:\Temp\qdm-continue"
```

When the flow pauses, create that file to resume:
```powershell
New-Item C:\Temp\qdm-continue
```

(None of the current shipping flows use `manualPause`. This only matters if you author a flow that needs an interactive interrupt — e.g. waiting for a user to upload a file the agent can't.)

---

## 8. Troubleshooting

**`auth: login screen detected — running Mart Portal credential flow`** then "did not reach an authenticated URL"
→ SSO cookies expired or credentials missing. Re-run §3.

**`locator.click: Timeout … MuiBackdrop … intercepts pointer events`**
→ A MUI popover backdrop is blocking the click. Add `"force": true` to the step in the flow JSON.

**`no run directory found in output/`**
→ You ran `npm run video` before any `npm run demo`. Run a flow first or pass an explicit `output/<run-dir>` to the video builder.

**`edge-tts not installed`** or `ModuleNotFoundError: No module named 'edge_tts'`
→ `pip install -r output/requirements.txt`. On Windows, use `python -m pip install ...` if `pip` is not in PATH.

**Video sounds robotic**
→ You're falling back to the macOS `say` engine. Pass `--engine edge --voice en-US-AvaMultilingualNeural` explicitly.

**Playwright complains about a missing browser**
→ Re-run `npx playwright install chromium`. On a corporate VPN, set `HTTPS_PROXY` first.

**Selectors break after a Quest UI release**
→ All selectors live in `flows/*.json`. Fix them there — no TypeScript edits needed for selector swaps.

---

## 9. What lives where

```
demo-agent/
├── agent/                 # flow runner (TypeScript)
│   ├── runner.ts          # CLI entrypoint for `npm run demo`
│   ├── flowExecutor.ts    # step loop + screenshots
│   ├── actionHandler.ts   # action implementations (click, type, …)
│   └── auth.ts            # Mart Portal SSO automation
├── ai/
│   ├── buildVideo.ts      # CLI entrypoint for `npm run video`
│   ├── captionRun.ts      # caption generation (Claude or fallback)
│   └── descriptionGenerator.ts
├── flows/                 # *.json — the only place you edit to add demos
│   ├── realQuest_unified.json
│   └── realQuest_ai_features.json
├── scripts/
│   ├── auto-login.ts      # refresh .qdm-profile
│   ├── bootstrap.ts
│   └── recon.ts           # one-shot DOM dump for new pages
├── assets/
│   └── quest_logo.png     # branding overlay
├── output/                # generated runs + video pipeline scripts
│   ├── videoGenerator.py  # frame composition + ffmpeg
│   ├── buildSlide.py      # standalone intro/outro slide
│   ├── buildUxAudit.py    # PPTX UX audit generator
│   └── requirements.txt
├── utils/
│   ├── logger.ts
│   └── routes.ts          # broken-runtime-config stub for QDM
├── .qdm-profile/          # Playwright persistent profile (created at runtime)
└── package.json
```

---

## 10. Quick reference — all-in-one command

The full pipeline in one line, copy-pasteable on macOS / Linux:

```bash
QDM_USER=adminuser QDM_PASS=Erwin123 \
  npx tsx scripts/auto-login.ts && \
  npm run demo -- --flow=realQuest_ai_features --headless && \
  npm run video -- --narrate --engine edge --voice en-US-AvaMultilingualNeural
```

PowerShell equivalent:
```powershell
$env:QDM_USER="adminuser"; $env:QDM_PASS="Erwin123"
npx tsx scripts/auto-login.ts; if ($?) { `
  npm run demo -- --flow=realQuest_ai_features --headless; if ($?) { `
    npm run video -- --narrate --engine edge --voice en-US-AvaMultilingualNeural `
  } `
}
```
