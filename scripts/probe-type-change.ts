/**
 * Open the AI-created Retail Core model and try to change its type from
 * Logical to Logical/Physical via the top-right dropdown.
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
  const outDir = path.resolve("output", `probe_type_change_${stamp}`);
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

    // Open the most recent Retail Core (a Logical model from the previous AI run)
    const link = page.locator('span:text-is("Retail Core")').first();
    await link.scrollIntoViewIfNeeded();
    await link.dblclick({ timeout: 10_000, force: true });
    await page.waitForURL(/modeler/i, { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(8000);
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(outDir, "01_modeler.png"), fullPage: false });

    // Find the "Logical" type dropdown at top-right
    const all = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 100; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      return Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], .MuiSelect-select')).slice(0, 200).map(function(el) {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName, text: trim(el.innerText, 80), aria: trim(el.getAttribute('aria-label'), 80),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0
        };
      }).filter(function(b) { return b.visible && (b.text || b.aria); });
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "01_buttons.json"), JSON.stringify(all, null, 2));

    const typeBtn = all.find((b: any) => /^Logical$/i.test((b.text || "").trim()) && b.y < 100);
    logger.info(`type dropdown: ${JSON.stringify(typeBtn)}`);

    if (!typeBtn) {
      logger.warn("no Logical-only top-right button found; dumping candidates near (top-right)");
      all.filter((b: any) => b.y < 100 && b.x > 1000).forEach((b: any) => logger.info(`  ${b.tag} @(${b.x},${b.y}) text="${b.text || ""}" aria="${b.aria || ""}"`));
      return;
    }

    // Click the type dropdown
    await page.mouse.click(typeBtn.x + Math.floor(typeBtn.w / 2), typeBtn.y + Math.floor(typeBtn.h / 2));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "02_type_dropdown.png"), fullPage: false });

    const typeItems = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      for (const sel of ['[role="menu"]', '[role="listbox"]', '.MuiMenu-paper', '.MuiPopover-paper']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          out.push({
            selector: sel,
            bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            items: Array.from(el.querySelectorAll('[role="menuitem"], [role="option"], li')).slice(0, 30).map(function(it) {
              const rr = it.getBoundingClientRect();
              return { text: trim(it.innerText, 100), x: Math.round(rr.x), y: Math.round(rr.y) };
            }).filter(function(x) { return x.text; })
          });
        }
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "02_items.json"), JSON.stringify(typeItems, null, 2));
    for (const po of typeItems) {
      logger.info(`  ${po.selector} bbox=${JSON.stringify(po.bbox)}`);
      po.items?.forEach((it: any) => logger.info(`    ${it.text} @(${it.x},${it.y})`));
    }

    // Click "Logical/Physical"
    const lpItem = typeItems.flatMap((po: any) => po.items || []).find((it: any) => it.text === "Logical/Physical");
    if (lpItem) {
      logger.info(`clicking Logical/Physical at (${lpItem.x}, ${lpItem.y})`);
      await page.mouse.click(lpItem.x + 30, lpItem.y + 10);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(outDir, "03_after_lp.png"), fullPage: false });

      // Look for any prompt about database / target
      const after = await page.evaluate(`(() => {
        function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
        const out = [];
        for (const sel of ['[role="dialog"]', '.MuiDialog-paper', '.MuiPopover-paper', '.MuiMenu-paper']) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            out.push({ selector: sel, text: trim(el.innerText, 800), bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
          }
        }
        return out;
      })()`) as any[];
      await fs.writeFile(path.join(outDir, "03_after_lp.json"), JSON.stringify(after, null, 2));
      for (const po of after) {
        logger.info(`  ${po.selector} bbox=${JSON.stringify(po.bbox)}`);
        logger.info(`    text: ${po.text}`);
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
