import { Page } from "playwright";
import * as path from "path";
import { logger } from "../utils/logger";

export type ActionKind =
  | "goto"
  | "click"
  | "clickAt"
  | "drag"
  | "type"
  | "press"
  | "setFile"
  | "wait"
  | "waitForCanvas"
  | "screenshot";

export interface FlowStep {
  action: ActionKind;
  selector?: string;
  value?: string;
  url?: string;
  label: string;
  timeoutMs?: number;
  delayMs?: number;
  /** For clickAt: pixel offsets relative to the located element's top-left.
   *  For drag: source coordinates (relative to selector's bounding box). */
  x?: number;
  y?: number;
  /** For drag: target coordinates (relative to selector's bounding box). */
  toX?: number;
  toY?: number;
  /** For drag: how many intermediate mouse-move steps to interpolate. */
  steps?: number;
  /** Optional override for the spoken narration on this step's video frame.
   *  Empty string = stay silent during this step (frame still holds for
   *  step_seconds). Omitted = fall back to the AI/label description. */
  narration?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_MS = 1_000;
const DEFAULT_CANVAS_DELAY_MS = 1_500;

export async function executeAction(page: Page, step: FlowStep): Promise<void> {
  const timeout = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  switch (step.action) {
    case "goto": {
      if (!step.url) throw new Error(`goto requires 'url' (step: ${step.label})`);
      await page.goto(step.url, { timeout, waitUntil: "domcontentloaded" });
      return;
    }

    case "click": {
      if (!step.selector) throw new Error(`click requires 'selector' (step: ${step.label})`);
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: "visible", timeout });
      await loc.click({ timeout });
      return;
    }

    case "clickAt": {
      if (!step.selector) throw new Error(`clickAt requires 'selector' (step: ${step.label})`);
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: "visible", timeout });
      const box = await loc.boundingBox();
      if (!box) throw new Error(`clickAt: bounding box unavailable (step: ${step.label})`);
      const x = step.x !== undefined ? step.x : box.width / 2;
      const y = step.y !== undefined ? step.y : box.height / 2;
      await page.mouse.click(box.x + x, box.y + y);
      return;
    }

    case "drag": {
      if (!step.selector) throw new Error(`drag requires 'selector' (step: ${step.label})`);
      if (step.x === undefined || step.y === undefined || step.toX === undefined || step.toY === undefined) {
        throw new Error(`drag requires x/y and toX/toY (step: ${step.label})`);
      }
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: "visible", timeout });
      const box = await loc.boundingBox();
      if (!box) throw new Error(`drag: bounding box unavailable (step: ${step.label})`);
      const startX = box.x + step.x;
      const startY = box.y + step.y;
      const endX = box.x + step.toX;
      const endY = box.y + step.toY;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: step.steps ?? 12 });
      await page.mouse.up();
      return;
    }

    case "type": {
      if (!step.selector || step.value === undefined) {
        throw new Error(`type requires 'selector' and 'value' (step: ${step.label})`);
      }
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: "visible", timeout });
      await loc.fill(step.value);
      return;
    }

    case "setFile": {
      if (!step.selector) throw new Error(`setFile requires 'selector' (step: ${step.label})`);
      if (!step.value) throw new Error(`setFile requires 'value' (file path) (step: ${step.label})`);
      const file = path.isAbsolute(step.value) ? step.value : path.resolve(step.value);
      // setInputFiles works on hidden file inputs too; no need to click Browse.
      await page.locator(step.selector).first().setInputFiles(file, { timeout });
      return;
    }

    case "press": {
      if (!step.value) throw new Error(`press requires 'value' (key) (step: ${step.label})`);
      if (step.selector) {
        await page.locator(step.selector).first().press(step.value, { timeout });
      } else {
        await page.keyboard.press(step.value);
      }
      return;
    }

    case "wait": {
      if (step.selector) {
        await page.locator(step.selector).first().waitFor({ state: "visible", timeout });
      } else {
        await page.waitForTimeout(step.delayMs ?? DEFAULT_WAIT_MS);
      }
      return;
    }

    case "waitForCanvas": {
      if (step.selector) {
        await page.locator(step.selector).first().waitFor({ state: "visible", timeout });
      }
      await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
      await page.waitForTimeout(step.delayMs ?? DEFAULT_CANVAS_DELAY_MS);
      return;
    }

    case "screenshot":
      // Screenshots are emitted by the executor after every step; this action is a no-op
      // and exists so flows can explicitly request an extra capture point if needed.
      return;

    default: {
      const _exhaustive: never = step.action;
      throw new Error(`Unknown action: ${String(_exhaustive)}`);
    }
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  label = "",
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`attempt ${i}/${attempts} failed for ${label}: ${msg}`);
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 750 * i));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
