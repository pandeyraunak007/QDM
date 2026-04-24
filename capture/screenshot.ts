import { Page, Locator, ElementHandle } from "playwright";
import * as path from "path";
import * as fs from "fs/promises";

export interface ScreenshotOptions {
  outputDir: string;
  name: string;
  highlight?: Locator;
  fullPage?: boolean;
  renderDelayMs?: number;
}

interface PriorStyles {
  outline: string;
  outlineOffset: string;
  boxShadow: string;
  transition: string;
}

export async function captureScreenshot(page: Page, opts: ScreenshotOptions): Promise<string> {
  const { outputDir, name, highlight, fullPage = true, renderDelayMs = 300 } = opts;
  await fs.mkdir(outputDir, { recursive: true });

  let restore: (() => Promise<void>) | undefined;
  if (highlight) {
    restore = await applyHighlight(highlight);
  }

  if (renderDelayMs > 0) {
    await page.waitForTimeout(renderDelayMs);
  }

  const filename = `${name}.png`;
  const fullPath = path.join(outputDir, filename);

  try {
    await page.screenshot({ path: fullPath, fullPage });
  } finally {
    if (restore) await restore().catch(() => undefined);
  }

  return fullPath;
}

async function applyHighlight(locator: Locator): Promise<() => Promise<void>> {
  let handle: ElementHandle<SVGElement | HTMLElement> | null = null;
  try {
    handle = await locator.elementHandle();
  } catch {
    return async () => undefined;
  }
  if (!handle) return async () => undefined;

  try {
    await handle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
  } catch {
    /* ignore */
  }

  const prior = await handle
    .evaluate((el: Element): PriorStyles | null => {
      const node = el as HTMLElement;
      if (!node.style) return null;
      const snapshot: PriorStyles = {
        outline: node.style.outline,
        outlineOffset: node.style.outlineOffset,
        boxShadow: node.style.boxShadow,
        transition: node.style.transition,
      };
      node.style.transition = "none";
      node.style.outline = "3px solid #ff3b30";
      node.style.outlineOffset = "2px";
      node.style.boxShadow = "0 0 0 6px rgba(255,59,48,0.25)";
      return snapshot;
    })
    .catch(() => null);

  if (!prior) return async () => undefined;

  return async () => {
    await handle!
      .evaluate((el: Element, p: PriorStyles) => {
        const node = el as HTMLElement;
        if (!node.style) return;
        node.style.outline = p.outline;
        node.style.outlineOffset = p.outlineOffset;
        node.style.boxShadow = p.boxShadow;
        node.style.transition = p.transition;
      }, prior)
      .catch(() => undefined);
  };
}
