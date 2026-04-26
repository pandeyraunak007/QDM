/**
 * Probe the Overview AI Model Generator panel for Model Type + Database controls.
 * The user reports there are buttons "below the AI page" to pick Model Type
 * (Logical/Physical) and Database (Microsoft Fabric / Data Warehouse).
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
  const outDir = path.resolve("output", `probe_ai_overview_controls_${stamp}`);
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
    await page.screenshot({ path: path.join(outDir, "01_ai_panel.png"), fullPage: false });

    // Get card bbox via Playwright locator
    const card = page.locator('text=AI Model Generator').locator("xpath=ancestor::*[1]/..").first();
    const cardBox = await card.boundingBox().catch(() => null);
    logger.info(`AI card bbox: ${JSON.stringify(cardBox)}`);

    // Dump every interactive element with bbox
    const all = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 80; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const all = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]'));
      return all.map(function(el) {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          ariaLabel: trim(el.getAttribute('aria-label'), 100),
          title: trim(el.getAttribute('title'), 100),
          text: trim(el.innerText, 80),
          dataTestId: trim(el.getAttribute('data-testid'), 80),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0
        };
      }).filter(function(b) { return b.visible && (b.ariaLabel || b.title || b.text || b.dataTestId); }).slice(0, 300);
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "02_all_interactive.json"), JSON.stringify(all, null, 2));

    // Find buttons within or just below the AI card
    if (cardBox) {
      const nearAi = all.filter((b: any) =>
        b.y >= cardBox.y - 5 && b.y <= cardBox.y + cardBox.height + 250 &&
        b.x >= cardBox.x - 20 && b.x <= cardBox.x + cardBox.width + 20,
      );
      await fs.writeFile(path.join(outDir, "03_near_ai_card.json"), JSON.stringify(nearAi, null, 2));
      logger.info(`buttons in/near AI card: ${nearAi.length}`);
      nearAi.forEach((b: any) => logger.info(`  ${b.tag} @(${b.x},${b.y}) ${b.w}x${b.h} aria="${b.ariaLabel || ""}" title="${b.title || ""}" text="${b.text || ""}" testid="${b.dataTestId || ""}"`));

      // Click each small icon button (no text or short text) inside the card
      const candidates = nearAi.filter((b: any) =>
        b.w < 60 && b.h < 60 && b.tag === "BUTTON",
      );
      logger.info(`small icon candidates: ${candidates.length}`);
      for (let i = 0; i < candidates.length; i++) {
        const b: any = candidates[i];
        const cx = b.x + Math.floor(b.w / 2);
        const cy = b.y + Math.floor(b.h / 2);
        logger.info(`click candidate #${i} @(${cx},${cy}) aria="${b.ariaLabel || ""}" title="${b.title || ""}"`);
        try {
          await page.mouse.click(cx, cy);
          await page.waitForTimeout(1500);
          await page.screenshot({ path: path.join(outDir, `05_after_click_${i}_${cx}_${cy}.png`), fullPage: false });
          const popover = await page.evaluate(`(() => {
            function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
            const sels = ['[role="menu"]', '[role="listbox"]', '[role="dialog"]', '.MuiPopover-paper', '.MuiPopper-root', '.MuiMenu-paper'];
            const out = [];
            for (const s of sels) {
              const els = Array.from(document.querySelectorAll(s));
              for (const el of els) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                out.push({
                  selector: s,
                  text: trim(el.innerText, 600),
                  items: Array.from(el.querySelectorAll('[role="menuitem"], [role="option"], li, button')).slice(0, 30).map(function(it) { return trim(it.innerText, 100); }).filter(Boolean)
                });
              }
            }
            return out;
          })()`) as any[];
          if (popover.length > 0) {
            await fs.writeFile(path.join(outDir, `05_after_click_${i}_${cx}_${cy}.json`), JSON.stringify(popover, null, 2));
            logger.info(`  popover items: ${(popover[0] as any)?.items?.join(" | ")}`);
          }
          await page.keyboard.press("Escape");
          await page.waitForTimeout(500);
        } catch (e) {
          logger.warn(`  click failed: ${(e as Error).message}`);
        }
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
