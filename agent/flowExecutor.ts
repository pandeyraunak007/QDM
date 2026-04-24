import { Page } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";
import { executeAction, withRetry, FlowStep } from "./actionHandler";
import { captureScreenshot } from "../capture/screenshot";
import { logger } from "../utils/logger";

export interface Flow {
  flow_name: string;
  base_url?: string;
  steps: FlowStep[];
}

export interface StepResult {
  index: number;
  label: string;
  action: string;
  selector?: string;
  value?: string;
  screenshot?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface FlowResult {
  flowName: string;
  outputDir: string;
  screenshotsDir: string;
  manifestPath: string;
  steps: StepResult[];
  ok: boolean;
}

export async function loadFlow(flowPath: string): Promise<Flow> {
  const raw = await fs.readFile(flowPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Flow file is not valid JSON: ${flowPath}: ${(err as Error).message}`);
  }
  const flow = parsed as Flow;
  if (!flow || typeof flow.flow_name !== "string" || !Array.isArray(flow.steps)) {
    throw new Error(`Flow file missing 'flow_name' or 'steps': ${flowPath}`);
  }
  for (const [i, step] of flow.steps.entries()) {
    if (!step.action || typeof step.action !== "string") {
      throw new Error(`Flow step #${i + 1} missing 'action': ${flowPath}`);
    }
    if (!step.label || typeof step.label !== "string") {
      throw new Error(`Flow step #${i + 1} missing 'label': ${flowPath}`);
    }
  }
  return flow;
}

export async function executeFlow(
  page: Page,
  flow: Flow,
  outputRoot: string,
): Promise<FlowResult> {
  const safeFlow = sanitize(flow.flow_name);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(outputRoot, `${safeFlow}_${stamp}`);
  const screenshotsDir = path.join(outputDir, "screenshots");
  await fs.mkdir(screenshotsDir, { recursive: true });

  logger.info(`flow: ${flow.flow_name} — ${flow.steps.length} steps`);
  logger.info(`output: ${outputDir}`);

  if (flow.base_url) {
    logger.info(`goto base_url: ${flow.base_url}`);
    await page.goto(flow.base_url, { waitUntil: "domcontentloaded" });
  }

  const results: StepResult[] = [];
  let aborted = false;

  for (let i = 0; i < flow.steps.length; i++) {
    if (aborted) break;
    const step = flow.steps[i];
    const index = i + 1;
    const started = Date.now();
    logger.info(`→ [${index}/${flow.steps.length}] ${step.label}`);

    try {
      await withRetry(() => executeAction(page, step), 3, `step ${index}: ${step.label}`);

      const highlight = step.selector ? page.locator(step.selector).first() : undefined;
      const shotName = `${String(index).padStart(2, "0")}_${sanitize(step.label).slice(0, 60)}`;
      const screenshot = await captureScreenshot(page, {
        outputDir: screenshotsDir,
        name: shotName,
        highlight,
        fullPage: step.action !== "waitForCanvas",
        renderDelayMs: step.action === "waitForCanvas" ? 800 : 300,
      });

      results.push({
        index,
        label: step.label,
        action: step.action,
        selector: step.selector,
        value: step.value,
        screenshot,
        durationMs: Date.now() - started,
        ok: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`✗ step ${index} failed: ${msg}`);
      const failShot = await safeCapture(page, screenshotsDir, index, step.label);
      results.push({
        index,
        label: step.label,
        action: step.action,
        selector: step.selector,
        value: step.value,
        screenshot: failShot,
        durationMs: Date.now() - started,
        ok: false,
        error: msg,
      });
      aborted = true;
    }
  }

  const manifestPath = path.join(outputDir, "steps.json");
  const manifest = {
    flow_name: flow.flow_name,
    base_url: flow.base_url,
    generated_at: new Date().toISOString(),
    total_steps: flow.steps.length,
    executed_steps: results.length,
    ok: !aborted,
    steps: results,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const ok = !aborted && results.every((s) => s.ok);
  const passCount = results.filter((s) => s.ok).length;
  logger.info(`flow finished: ${ok ? "SUCCESS" : "FAILED"} — ${passCount}/${flow.steps.length} steps`);

  return { flowName: flow.flow_name, outputDir, screenshotsDir, manifestPath, steps: results, ok };
}

async function safeCapture(
  page: Page,
  dir: string,
  index: number,
  label: string,
): Promise<string | undefined> {
  try {
    return await captureScreenshot(page, {
      outputDir: dir,
      name: `${String(index).padStart(2, "0")}_${sanitize(label).slice(0, 60)}_FAILED`,
      fullPage: true,
      renderDelayMs: 0,
    });
  } catch {
    return undefined;
  }
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
