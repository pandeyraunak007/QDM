/**
 * One-shot probe: open an existing or freshly created model in the QDM
 * diagram editor and dump every clickable/labelled element so we can
 * discover stable selectors for "Add Entity", "Save", etc.
 *
 * Usage: npx ts-node scripts/probe-editor.ts
 *
 * Reuses .qdm-profile/ for the authenticated session.
 */
import { chromium, Page } from "playwright";
import * as fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { stubBrokenRuntimeConfig } from "../utils/routes";

const PROFILE_DIR = path.resolve(".qdm-profile");

async function main(): Promise<void> {
  if (!existsSync(PROFILE_DIR)) {
    throw new Error(".qdm-profile/ not found — run npm run bootstrap or scripts/auto-login.ts first");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("output", `probe_editor_${stamp}`);
  mkdirSync(outDir, { recursive: true });
  logger.info(`output: ${outDir}`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await stubBrokenRuntimeConfig(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => logger.warn(`pageerror: ${e.message}`));

  try {
    logger.info("navigating to /overview");
    await page.goto("http://questpmdmc.myerwin.com/overview", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForSelector("text=Welcome back", { timeout: 60_000 });
    await page.waitForTimeout(2000);

    logger.info("creating a probe model");
    await page.locator('p:text-is("New Model")').click();
    await page.waitForSelector('input[placeholder="Model Name"]', { timeout: 15_000 });
    const probeName = `Probe_${stamp.slice(0, 19)}`;
    await page.locator('input[placeholder="Model Name"]').fill(probeName);
    await page.locator('label:has-text("Logical"):not(:has-text("/"))').click();
    await page.locator('button:has-text("Create")').click();

    logger.info("waiting for diagram editor");
    await page.waitForTimeout(15_000);
    await page.screenshot({ path: path.join(outDir, "editor.png"), fullPage: true });

    await dumpEditor(page, outDir, "editor");

    logger.info("clicking Add Entity + placing on canvas");
    await page.locator('[aria-label="Add Entity"]').click();
    await page.waitForTimeout(800);
    await page.mouse.click(700, 400);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, "new_entity_dialog.png"), fullPage: true });
    await dumpEditor(page, outDir, "new_entity_dialog");

    // Dump every input + every label in the dialog with structural details
    const dialogShape = await page.evaluate(() => {
      const trim = (s: string | null | undefined, n = 100): string | undefined =>
        s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) || undefined : undefined;
      return {
        inputs: Array.from(document.querySelectorAll("input, textarea")).map((el) => {
          const html = el as HTMLInputElement;
          // Walk up to find an associated label by scanning preceding siblings
          let label: string | undefined;
          let cur: Element | null = el.parentElement;
          for (let depth = 0; depth < 4 && cur && !label; depth += 1, cur = cur.parentElement) {
            const labels = cur.querySelectorAll("label, [class*='label' i]");
            for (const l of labels) {
              const t = (l as HTMLElement).innerText;
              if (t) {
                label = trim(t, 60);
                break;
              }
            }
          }
          return {
            type: trim(html.type, 30),
            value: trim(html.value, 60),
            placeholder: trim(html.placeholder, 60),
            id: trim(html.id, 60),
            name: trim(html.name, 60),
            required: html.required,
            ariaLabel: trim(el.getAttribute("aria-label"), 60),
            associatedLabel: label,
          };
        }),
        dialogTitles: Array.from(document.querySelectorAll('h1, h2, h3, [role="dialog"] *')).slice(0, 20).map((el) => trim((el as HTMLElement).innerText, 60)).filter(Boolean),
      };
    });
    await fs.writeFile(path.join(outDir, "dialog_shape.json"), JSON.stringify(dialogShape, null, 2), "utf-8");

    // Skip the right-click probe on this run — the New Entity dialog is the priority.
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(800);

    // Also try right-clicking on the canvas to surface the context menu
    logger.info("attempting right-click on canvas to expose context menu");
    const canvas = page.locator("canvas, svg, .konvajs-content, [class*='canvas' i], [class*='diagram' i]").first();
    if ((await canvas.count()) > 0) {
      const box = await canvas.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(outDir, "after_right_click.png"), fullPage: true });
        await dumpEditor(page, outDir, "after_right_click");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      }
    }

    // Hover the bottom toolbar to capture tooltips
    logger.info("hovering toolbar to surface tooltip text");
    const toolbarButtons = await page.locator('button').all();
    const tooltipDump: Array<{ index: number; ariaLabel?: string; tooltip?: string; text?: string }> = [];
    for (let i = 0; i < Math.min(toolbarButtons.length, 60); i += 1) {
      const btn = toolbarButtons[i];
      try {
        const visible = await btn.isVisible({ timeout: 100 }).catch(() => false);
        if (!visible) continue;
        await btn.hover({ timeout: 1000 }).catch(() => undefined);
        await page.waitForTimeout(350);
        const ariaLabel = (await btn.getAttribute("aria-label")) ?? undefined;
        const text = (await btn.innerText().catch(() => ""))?.slice(0, 60);
        const tooltip = await page
          .locator('[role="tooltip"], .MuiTooltip-tooltip')
          .first()
          .innerText({ timeout: 500 })
          .catch(() => "");
        tooltipDump.push({ index: i, ariaLabel, tooltip: tooltip || undefined, text: text || undefined });
      } catch {
        /* skip */
      }
    }
    await fs.writeFile(path.join(outDir, "toolbar_tooltips.json"), JSON.stringify(tooltipDump, null, 2), "utf-8");
    logger.info(`captured tooltips for ${tooltipDump.length} buttons`);

    logger.info(`done — see ${outDir}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function dumpEditor(page: Page, outDir: string, label: string): Promise<void> {
  const dump = await page.evaluate(() => {
    const trim = (s: string | null | undefined, n = 120): string | undefined => {
      if (!s) return undefined;
      const t = String(s).replace(/\s+/g, " ").trim();
      return t ? t.slice(0, n) : undefined;
    };
    const all = Array.from(
      document.querySelectorAll(
        '[aria-label], button, [role="button"], [role="menuitem"], [role="tab"], [data-testid]',
      ),
    );
    const seen = new Set<Element>();
    return all
      .filter((el) => {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      })
      .slice(0, 250)
      .map((el) => {
        const html = el as HTMLElement;
        return {
          tag: el.tagName,
          role: trim(el.getAttribute("role"), 30),
          ariaLabel: trim(el.getAttribute("aria-label"), 100),
          text: trim(html.innerText, 80),
          id: trim(el.id, 60),
          dataTestId: trim(el.getAttribute("data-testid") || el.getAttribute("data-test"), 60),
          title: trim(el.getAttribute("title"), 80),
        };
      })
      .filter((x) => x.ariaLabel || x.text || x.dataTestId || x.title);
  });
  await fs.writeFile(path.join(outDir, `${label}_dump.json`), JSON.stringify(dump, null, 2), "utf-8");
  logger.info(`${label} dump: ${dump.length} elements`);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
