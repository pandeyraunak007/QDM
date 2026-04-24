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

## Roadmap

- **Phase 2** — `ai/descriptionGenerator.ts` (Claude/OpenAI) produces slide
  titles + beginner-friendly descriptions from each step's `label`, then
  `output/pptGenerator.py` (python-pptx) builds `demo.pptx` from the manifest.
- **Phase 3** — smarter canvas-render detection (DOM-diff / pixel-diff),
  before/after screenshots for diagram changes, zoom-into-entity, modal/popup
  handling helpers, optional FFmpeg video + narration, reusable model templates.

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
