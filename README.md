# Quest Demo Agent — Phase 1

Phase 1 of the **AI Demo Generator for Quest Data Modeler**: a Playwright-driven
flow runner that walks through data-modeling steps in a browser and captures a
labelled screenshot after each step, plus a `steps.json` manifest that Phase 2
(PPT / AI narration) will consume.

> Scope: Phase 1 only — Playwright setup, flow execution, screenshot capture.
> Phase 2 (PPT + AI descriptions) and Phase 3 (advanced waits, video) are
> planned but not implemented yet.

---

## Project layout

```
demo-agent/
├── agent/
│   ├── runner.ts          # CLI entry point
│   ├── flowExecutor.ts    # loads flow JSON, runs steps, emits manifest
│   └── actionHandler.ts   # per-action dispatch + retry
├── capture/
│   └── screenshot.ts      # full-page capture + element highlight
├── flows/
│   ├── createModel.json   # sample: create a new ER model
│   ├── addEntities.json   # sample: add entities + relationship
│   └── demo_local.json    # runs against the bundled mock fixture
├── fixtures/
│   └── mock-modeler.html  # self-contained mock of the Data Modeler UI
├── utils/logger.ts
├── ai/                    # (Phase 2) descriptionGenerator.ts
├── output/                # generated run artifacts (gitignored)
├── package.json
└── tsconfig.json
```

---

## Setup

Requires **Node 18+**.

```bash
cd demo-agent
npm install
npx playwright install chromium
```

---

## Quick start — run against the local mock

The mock fixture lets you exercise the full pipeline without needing a live
Quest Data Modeler URL.

```bash
npm run demo -- --flow=demo_local
```

Artifacts land in `output/<flow_name>_<timestamp>/`:

```
output/local_mock_create_er_model_2026-04-24T.../
├── steps.json                         # manifest consumed by Phase 2
└── screenshots/
    ├── 01_wait_for_quest_data_modeler_shell.png
    ├── 02_click_new_model.png
    └── ...
```

---

## Run against a real Quest Data Modeler instance

Real QDM instances typically sit behind SSO, and their SPA bundles often
crash on cold (cookie-less) Playwright contexts before the login form can
render. Use the one-time **bootstrap** step to capture an authenticated
session, then all subsequent runs reuse it.

**1. Bootstrap (once per session expiry)**

```bash
QDM_URL=http://your-instance/auth/login npm run bootstrap
```

A headful Chromium window opens, pointed at the login URL. Sign in
manually — including any SSO / "Continue with Microsoft" flow. When the
app finishes loading, close the browser window. The session (cookies,
localStorage, service workers) is persisted to `.qdm-profile/`
(gitignored).

**2. Run a flow**

```bash
npm run demo -- --flow=createModel --url=http://your-instance
```

The runner auto-detects `.qdm-profile/` and reuses it via Playwright's
`launchPersistentContext`. You land already-authenticated.

Flags:

- `--profile <dir>` — use an explicit profile directory
- `--no-profile` — ignore any auto-detected profile and run fresh (useful
  for the bundled mock)

**Bonus helper — `npm run recon`.** Navigates to `QDM_URL`, logs in if
`QDM_USER`/`QDM_PASS` are set, dumps the DOM selectors and network trace
to `output/recon_<timestamp>/`. Useful for discovering real selectors
before authoring a flow.

### Without SSO / public URL

If your instance doesn't need auth, skip bootstrap and use `--url`:

```bash
npm run demo -- --flow=createModel --url=https://your-quest-instance.example.com
```

The CLI options:

| Flag             | Default       | Purpose                                                   |
| ---------------- | ------------- | --------------------------------------------------------- |
| `-f, --flow`     | _(required)_  | Flow name (e.g. `createModel`) or path to a `.json` file  |
| `-u, --url`      | _(none)_      | Override the flow's `base_url`                            |
| `-o, --output`   | `output`      | Root output directory                                     |
| `--flows-dir`    | `flows`       | Where to resolve flow names                               |
| `--headless`     | `false`       | Run headless (default is headful so demos are watchable)  |
| `--viewport`     | `1440x900`    | Browser viewport                                          |
| `--slow-mo`      | `150`         | Playwright `slowMo` in ms between actions                 |

---

## Flow schema

A flow is a JSON file describing an ordered list of steps:

```json
{
  "flow_name": "Create ER Model",
  "base_url": "https://app.questdatamodeler.example.com",
  "steps": [
    { "action": "click", "selector": "#new-model", "label": "Click on New Model" },
    { "action": "waitForCanvas", "selector": "#model-canvas", "label": "Wait for modeling canvas" },
    { "action": "type", "selector": "#entity-name", "value": "Customer", "label": "Name the entity" }
  ]
}
```

Supported actions:

| action          | required fields                    | behaviour                                                                  |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `goto`          | `url`                              | Navigate to a URL.                                                         |
| `click`         | `selector`                         | Wait for visible, then click the first match.                              |
| `type`          | `selector`, `value`                | Wait for visible, then `fill()` the value.                                 |
| `press`         | `value` (key), optional `selector` | `press()` a key (on element if selector given, else global keyboard).      |
| `wait`          | `selector` _or_ `delayMs`          | Wait for element visibility, or sleep `delayMs` if no selector.            |
| `waitForCanvas` | optional `selector`, `delayMs`     | Wait for element + `networkidle` + short delay; ideal for canvas renders.  |
| `screenshot`    | _(none)_                           | No-op; every step already captures a screenshot. Reserved for Phase 2.     |

Every step **must** include a human-readable `label` — it's used for the
screenshot filename and as the slide title in Phase 2.

Each step is wrapped in a **3-attempt retry** with exponential back-off. If a
step fails after 3 attempts, the executor captures a `*_FAILED.png` and aborts
that flow run (remaining steps are not executed).

---

## Output manifest (`steps.json`)

Each run writes a manifest describing every executed step. Phase 2 will feed
this into the AI description generator and the PPT builder.

```json
{
  "flow_name": "Create ER Model",
  "base_url": "https://app.questdatamodeler.example.com",
  "generated_at": "2026-04-24T18:12:33.000Z",
  "total_steps": 6,
  "executed_steps": 6,
  "ok": true,
  "steps": [
    {
      "index": 1,
      "label": "Click on New Model",
      "action": "click",
      "selector": "#new-model",
      "screenshot": "/abs/path/.../screenshots/01_click_on_new_model.png",
      "durationMs": 312,
      "ok": true
    }
  ]
}
```

---

## Screenshot behaviour

- **Full-page** captures by default, so canvas content below the fold is included.
- **Target highlight**: before each step's screenshot, the target selector is
  outlined in red (`outline` + `box-shadow`) and restored afterward, so the
  viewer can see which element the step acted on.
- **Render delay**: a short delay (300 ms, or 800 ms for `waitForCanvas`) is
  applied before capture so in-flight diagram renders settle.

---

## Known limitations (Phase 1)

- **Selectors are placeholders.** `flows/createModel.json` and `addEntities.json`
  target generic IDs (`#new-model`, `#add-entity`, `#entity-name`) — these need
  to be updated to match the actual Quest Data Modeler DOM before running
  against the live app. Use the browser devtools + Playwright inspector
  (`PWDEBUG=1 npm run demo -- ...`) to discover real selectors.
- **Canvas-based UIs.** If a region of the Data Modeler is rendered on
  `<canvas>`, Playwright can't target its internals by CSS selector. In Phase 3
  we plan to add coordinate-based clicks and image-region detection.
- **No auth bootstrap.** Flows assume the browser session is already authenticated
  (or that the target URL is public). We'll add a `login` flow helper later.
- **No AI descriptions / PPT yet.** `steps.json` is generated for Phase 2 to
  consume; `ai/` and the Python PPT generator are not wired up yet.
- **No video.** FFmpeg video assembly is Phase 3.

---

## Phase 2 — generate a PowerPoint deck from a run

After a flow finishes, turn the run's screenshots + manifest into
`demo.pptx` (cover slide + one slide per step with title, description,
and screenshot).

**One-time setup**

```bash
pip install -r output/requirements.txt
# optional, for LLM-written captions:
export ANTHROPIC_API_KEY=sk-ant-...
```

**Build a deck**

```bash
npm run pptx                          # picks the most recent output/<run>
npm run pptx -- output/<run-dir>      # explicit run directory
```

The orchestrator (`ai/buildDeck.ts`):

1. Reads `<run>/steps.json`.
2. Calls Claude (`claude-haiku-4-5`) once with all step labels and gets
   back `{title, description}` per step. With no `ANTHROPIC_API_KEY`, it
   falls back to label-based captions (still produces a usable deck).
3. Writes `<run>/steps_described.json`.
4. Spawns `output/pptGenerator.py` (python-pptx) which writes
   `<run>/demo.pptx` — 13.33" × 7.5" widescreen, cover + one slide per
   step, screenshot scaled with preserved aspect ratio.

## Phase 3 — render the run as an MP4

Same inputs as the deck, different output: a captioned 1920×1080 H.264 MP4.

```bash
npm run video                                # latest run, default timing
npm run video -- output/<run-dir>            # explicit run directory
npm run video -- --step-seconds 5            # hold each step longer
npm run video -- --cover-seconds 4 --fps 60
npm run video -- --narrate                   # add a voice-over (macOS only)
npm run video -- --narrate --voice Daniel    # different `say` voice
```

Each frame is composed in Pillow (cover slide + one frame per step with a
caption strip and the screenshot scaled to fit), then assembled by FFmpeg
into `<run>/demo.mp4`. The captions reuse `steps_described.json` from
Phase 2 if present, otherwise they're generated with the same logic.

**Narration** (`--narrate`). Per-frame durations grow to fit the spoken
audio plus a 0.5s buffer (never shorter than the base `--step-seconds`);
each clip is padded with silence to match its frame, and FFmpeg muxes
video + audio in one pass to AAC.

Two TTS engines are supported via `--engine`:

| engine        | quality    | install                        | platform              |
| ------------- | ---------- | ------------------------------ | --------------------- |
| `say` (default) | decent      | built into macOS              | macOS only            |
| `edge`        | **neural — much more natural** | `pip install -r output/requirements.txt` | macOS / Linux / Windows |

Examples:

```bash
npm run video -- --narrate                                    # macOS say + Samantha
npm run video -- --narrate --voice 'Ava (Premium)'            # macOS say + premium voice (must download in System Settings → Accessibility → Spoken Content → Manage Voices)
npm run video -- --narrate --engine edge                      # Edge neural TTS, en-US-AriaNeural
npm run video -- --narrate --engine edge --voice en-US-JennyNeural   # warmer voice
```

Common Edge neural voices that sound great for product walkthroughs:
`en-US-AriaNeural` (default, balanced), `en-US-JennyNeural` (warm),
`en-US-AshleyNeural` (clear narrator), `en-US-DavisNeural` (male, calm),
`en-US-GuyNeural` (male, neutral). Full list: `python3 -m edge_tts --list-voices`.

**The narration script itself** comes from `steps_described.json`. With
`ANTHROPIC_API_KEY` set, Claude (haiku-4-5) writes natural one- or two-
sentence descriptions designed to read well when spoken (no em-dashes,
abbreviations, or fragments). Without a key, the agent uses each step's
label verbatim as its narration — also clean to listen to, just less
contextual. To regenerate captions after changing the prompt or adding
a key, delete `steps_described.json` from the run dir before running.

FFmpeg discovery order: system `ffmpeg` first, then the static binary
shipped by `imageio-ffmpeg` (installed by `pip install -r
output/requirements.txt`). The Playwright-bundled FFmpeg is intentionally
not used — its build is stripped down (no x264 / mp4 / concat).

## Roadmap

- **Phase 3 extras** — smarter canvas-render detection (DOM-diff / pixel-diff),
  before/after screenshots for diagram changes, zoom-into-entity, modal/popup
  handling helpers, voice narration, reusable model templates, sensitive-data
  masking.

## Bonus ideas

- **As a Quest feature.** Ship the agent as "Record Demo" inside the Data
  Modeler itself — the app emits the flow JSON as the user clicks, and the
  agent replays it in a headless worker to produce onboarding collateral.
- **Auto-generated docs.** After a modeling session, feed the manifest plus the
  final model graph to the LLM to generate a data-dictionary-style markdown
  doc (entities → attributes → relationships → rationale).
- **Autonomous modeling assistant.** Invert the flow: given a prompt ("model
  a SaaS billing system"), the LLM emits flow JSON, the agent executes it, and
  the screenshots become live feedback for the next planning turn.
