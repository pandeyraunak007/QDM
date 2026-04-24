import { Page } from "playwright";
import { logger } from "../utils/logger";

export type ActionKind =
  | "goto"
  | "click"
  | "type"
  | "press"
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

    case "type": {
      if (!step.selector || step.value === undefined) {
        throw new Error(`type requires 'selector' and 'value' (step: ${step.label})`);
      }
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: "visible", timeout });
      await loc.fill(step.value);
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
