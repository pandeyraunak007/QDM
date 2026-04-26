/**
 * Click the two icons at the bottom-left of the AI textarea (paperclip + sliders)
 * directly by coordinate, dump the popovers/menus.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../utils/logger";
import { stubBrokenRuntimeConfig } from "../utils/routes";
import { ensureAuthenticated } from "../agent/auth";

const PROFILE_DIR = path.resolve(".qdm-profile");

async function main(): Promise<void> {
  if (!existsSync(PROFILE_DIR)) throw new Error(".qdm-profile not found");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("output", `probe_ai_icons_${stamp}`);
  mkdirSync(outDir, { recursive: true });
  logger.info(`output: ${outDir}`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await stubBrokenRuntimeConfig(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  try {
    await page.goto("http://questpmdmc.myerwin.com/overview", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await ensureAuthenticated(page).catch((e) => logger.warn(`auth: ${(e as Error).message}`));
    await page.waitForSelector("text=Welcome back", { timeout: 60_000 });
    await page.waitForTimeout(2000);

    await page.locator('button:has-text("Click here to get started")').first().click({ timeout: 10_000 });
    await page.waitForSelector("textarea", { timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "01_panel_open.png"), fullPage: false });

    // Probe candidates near the bottom-left of the textarea — icons appear approx (170-225, 638-650)
    const positions = [
      { name: "paperclip", x: 185, y: 644 },
      { name: "sliders", x: 220, y: 644 },
    ];

    for (const p of positions) {
      logger.info(`clicking ${p.name} at (${p.x}, ${p.y})`);
      try {
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(outDir, `02_${p.name}_click.png`), fullPage: false });

        // Capture any popover/menu/dialog content
        const popover = await page.evaluate(`(() => {
          function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
          const sels = ['[role="menu"]', '[role="listbox"]', '[role="dialog"]', '.MuiPopover-paper', '.MuiPopper-root', '.MuiMenu-paper', '.MuiTooltip-popper'];
          const out = [];
          for (const s of sels) {
            const els = Array.from(document.querySelectorAll(s));
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              out.push({
                selector: s,
                bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                text: trim(el.innerText, 800),
                items: Array.from(el.querySelectorAll('[role="menuitem"], [role="option"], li, button, [role="radio"], input')).slice(0, 50).map(function(it) {
                  return {
                    tag: it.tagName,
                    text: trim(it.innerText, 100),
                    aria: trim(it.getAttribute('aria-label'), 100),
                    role: it.getAttribute('role'),
                    type: it.getAttribute && it.getAttribute('type')
                  };
                }).filter(function(x) { return x.text || x.aria; })
              });
            }
          }
          return out;
        })()`) as any[];

        await fs.writeFile(path.join(outDir, `02_${p.name}.json`), JSON.stringify(popover, null, 2));
        if (popover.length > 0) {
          logger.info(`  ${p.name} popovers: ${popover.length}`);
          for (const po of popover) {
            logger.info(`    ${po.selector} bbox=${JSON.stringify(po.bbox)}`);
            logger.info(`    text: ${po.text}`);
            logger.info(`    items: ${po.items?.map((it: any) => it.text || it.aria).filter(Boolean).join(" | ")}`);
          }
        } else {
          logger.warn(`  ${p.name} click produced no popover`);
        }

        // Close any open popover
        await page.keyboard.press("Escape");
        await page.waitForTimeout(800);
        // Re-click on textarea to make sure panel is still open
        await page.locator("textarea").first().click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(500);
      } catch (e) {
        logger.warn(`  click ${p.name} failed: ${(e as Error).message}`);
      }
    }

    logger.info(`done: ${outDir}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
