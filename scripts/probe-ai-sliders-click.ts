/**
 * Click the sliders icon button at exact bbox center, dump everything that appears.
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
  const outDir = path.resolve("output", `probe_sliders_${stamp}`);
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

    // The two icon buttons inside the textarea footer are MuiIconButton children of the textarea container.
    // Find them via DOM, click each via locator.
    const handles = await page.evaluateHandle(`(() => {
      const buttons = Array.from(document.querySelectorAll('button.MuiIconButton-root'));
      // Filter to those near y=635 and x<300 (inside AI textarea footer)
      const near = buttons.filter(function(b) {
        const r = b.getBoundingClientRect();
        return r.y >= 600 && r.y <= 680 && r.x < 300;
      });
      return near;
    })()`);
    const props = await handles.getProperties();
    const buttons: any[] = [];
    for (const [_, h] of props) {
      const elem = h.asElement();
      if (elem) buttons.push(elem);
    }
    logger.info(`found ${buttons.length} icon buttons in AI footer`);

    for (let i = 0; i < buttons.length; i++) {
      const btn: any = buttons[i];
      const box = await btn.boundingBox();
      logger.info(`button #${i} bbox=${JSON.stringify(box)}`);
      try {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(outDir, `01_btn_${i}_clicked.png`), fullPage: false });

        const popoverDump = await page.evaluate(`(() => {
          function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
          const out = [];
          const sels = ['[role="menu"]', '[role="listbox"]', '[role="dialog"]', '.MuiPopover-paper', '.MuiPopover-root', '.MuiPopper-root', '.MuiMenu-paper', '.MuiTooltip-tooltip'];
          for (const s of sels) {
            for (const el of Array.from(document.querySelectorAll(s))) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              out.push({
                selector: s,
                bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                text: trim(el.innerText, 1000),
                items: Array.from(el.querySelectorAll('[role="menuitem"], [role="option"], li, button, [role="radio"], input, label')).slice(0, 50).map(function(it) {
                  return {
                    tag: it.tagName,
                    text: trim(it.innerText, 100),
                    aria: trim(it.getAttribute('aria-label'), 100),
                    role: it.getAttribute('role'),
                    type: it.getAttribute('type'),
                    name: it.getAttribute('name'),
                    value: it.getAttribute('value')
                  };
                }).filter(function(x) { return x.text || x.aria || x.value; })
              });
            }
          }
          return out;
        })()`) as any[];
        await fs.writeFile(path.join(outDir, `01_btn_${i}.json`), JSON.stringify(popoverDump, null, 2));
        logger.info(`  popovers found: ${popoverDump.length}`);
        for (const po of popoverDump) {
          logger.info(`    ${po.selector} bbox=${JSON.stringify(po.bbox)}`);
          const snippet = (po.text || "").slice(0, 300);
          logger.info(`    text: ${snippet}`);
          const items = po.items?.map((it: any) => it.text || it.aria || it.value).filter(Boolean).slice(0, 25);
          logger.info(`    items: ${items?.join(" | ")}`);
        }

        // Close popover
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      } catch (e) {
        logger.warn(`  click failed: ${(e as Error).message}`);
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
