/**
 * Open the sliders popover, click Logical/Physical, then snapshot.
 * Hopefully a Database selector becomes visible.
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
  const outDir = path.resolve("output", `probe_pick_lp_${stamp}`);
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

    // Click sliders icon — second MuiIconButton in AI footer
    await page.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button.MuiIconButton-root')).filter(function(b) {
        const r = b.getBoundingClientRect();
        return r.y >= 600 && r.y <= 680 && r.x < 300;
      });
      if (buttons[1]) buttons[1].click();
    })()`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "01_popover_open.png"), fullPage: false });

    // Click "Logical/Physical" radio (force past backdrop)
    await page.locator(':text-is("Logical/Physical")').first().click({ timeout: 5000, force: true });
    await page.waitForTimeout(1500);
    // Scroll back to top so the AI panel is in view
    await page.evaluate("window.scrollTo(0, 0)");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, "02_after_lp_select.png"), fullPage: true });

    // Dump full popover state
    const dump1 = await page.evaluate(`(() => {
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
            text: trim(el.innerText, 1500)
          });
        }
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "02_after_lp_state.json"), JSON.stringify(dump1, null, 2));
    logger.info(`popovers after LP select: ${dump1.length}`);
    for (const po of dump1) {
      logger.info(`  ${po.selector} bbox=${JSON.stringify(po.bbox)}`);
      logger.info(`    text: ${po.text}`);
    }

    // Click outside to close popover, snapshot the AI panel state
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
    await page.evaluate("window.scrollTo(0, 0)");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, "03_panel_after_lp.png"), fullPage: true });

    // Now look for any new control near the textarea / footer
    const aiControls = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      const all = Array.from(document.querySelectorAll('button, [role="button"], select, [role="combobox"], input'));
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.y < 380 || r.y > 720) continue;
        if (r.width === 0 || r.height === 0) continue;
        out.push({
          tag: el.tagName,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          text: trim(el.innerText, 100),
          aria: trim(el.getAttribute('aria-label'), 100),
          role: el.getAttribute('role'),
          dataTestId: trim(el.getAttribute('data-testid'), 80),
          placeholder: el.getAttribute('placeholder'),
          value: el.getAttribute('value')
        });
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "03_ai_controls.json"), JSON.stringify(aiControls, null, 2));
    logger.info(`AI controls: ${aiControls.length}`);
    for (const c of aiControls) {
      logger.info(`  ${c.tag} @(${c.x},${c.y}) ${c.w}x${c.h} text="${c.text || ""}" aria="${c.aria || ""}" placeholder="${c.placeholder || ""}" testid="${c.dataTestId || ""}"`);
    }

    // Click the sliders icon AGAIN — maybe LP added new controls in the popover
    await page.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button.MuiIconButton-root')).filter(function(b) {
        const r = b.getBoundingClientRect();
        return r.y >= 600 && r.y <= 680 && r.x < 300;
      });
      if (buttons[1]) buttons[1].click();
    })()`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "04_sliders_reopen.png"), fullPage: false });

    const dump2 = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      for (const el of Array.from(document.querySelectorAll('.MuiPopover-paper'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        out.push({
          bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          text: trim(el.innerText, 2000),
          items: Array.from(el.querySelectorAll('label, button, [role="radio"], input, select, [role="combobox"]')).slice(0, 60).map(function(it) {
            const rr = it.getBoundingClientRect();
            return {
              tag: it.tagName,
              text: trim(it.innerText, 100),
              type: it.getAttribute('type'),
              x: Math.round(rr.x), y: Math.round(rr.y)
            };
          }).filter(function(x) { return x.text; })
        });
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "04_sliders_reopen.json"), JSON.stringify(dump2, null, 2));
    for (const po of dump2) {
      logger.info(`reopen popover bbox=${JSON.stringify(po.bbox)}`);
      logger.info(`  text: ${po.text}`);
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
