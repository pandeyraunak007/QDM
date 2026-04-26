/**
 * After picking Logical/Physical, the AI panel reveals two pills:
 *   - Logical/Physical chip
 *   - Microsoft Fabric dropdown (database)
 * Probe the Microsoft Fabric dropdown to see what database options exist.
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
  const outDir = path.resolve("output", `probe_fabric_${stamp}`);
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

    // Click sliders icon
    await page.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button.MuiIconButton-root')).filter(function(b) {
        const r = b.getBoundingClientRect();
        return r.y >= 600 && r.y <= 680 && r.x < 300;
      });
      if (buttons[1]) buttons[1].click();
    })()`);
    await page.waitForTimeout(1500);

    // Click Logical/Physical via JS dispatchClick on the label
    await page.evaluate(`(() => {
      const labels = Array.from(document.querySelectorAll('label, [role="radio"], li, span')).filter(function(el) {
        return (el.textContent || '').trim() === 'Logical/Physical';
      });
      if (labels[0]) {
        labels[0].click();
      }
    })()`);
    await page.waitForTimeout(1500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "01_after_lp.png"), fullPage: false });

    // Now find and click the "Microsoft Fabric" dropdown
    const allInteractive = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      return Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], select, .MuiSelect-select, [class*="Select"]')).slice(0, 100).map(function(el) {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          text: trim(el.innerText, 100),
          aria: trim(el.getAttribute('aria-label'), 100),
          role: el.getAttribute('role'),
          className: (el.getAttribute('class') || '').slice(0, 80),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0
        };
      }).filter(function(b) { return b.visible && (b.text || b.aria); });
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "01_interactive.json"), JSON.stringify(allInteractive, null, 2));
    const fabricBtn = allInteractive.find((b: any) => /Microsoft Fabric|Fabric/i.test(b.text || ""));
    logger.info(`fabric button: ${JSON.stringify(fabricBtn)}`);

    if (fabricBtn) {
      await page.mouse.click(fabricBtn.x + Math.floor(fabricBtn.w / 2), fabricBtn.y + Math.floor(fabricBtn.h / 2));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(outDir, "02_fabric_open.png"), fullPage: false });

      const fabricItems = await page.evaluate(`(() => {
        function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
        const out = [];
        for (const sel of ['[role="menu"]', '[role="listbox"]', '.MuiMenu-paper', '.MuiPopover-paper', '[role="option"]']) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            out.push({
              selector: sel,
              bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              text: trim(el.innerText, 1000),
              items: Array.from(el.querySelectorAll('[role="menuitem"], [role="option"], li')).slice(0, 30).map(function(it) {
                const rr = it.getBoundingClientRect();
                return { text: trim(it.innerText, 100), x: Math.round(rr.x), y: Math.round(rr.y) };
              }).filter(function(x) { return x.text; })
            });
          }
        }
        return out;
      })()`) as any[];
      await fs.writeFile(path.join(outDir, "02_fabric_items.json"), JSON.stringify(fabricItems, null, 2));
      for (const po of fabricItems) {
        logger.info(`  ${po.selector}`);
        po.items?.forEach((it: any) => logger.info(`    ${it.text} @(${it.x},${it.y})`));
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
