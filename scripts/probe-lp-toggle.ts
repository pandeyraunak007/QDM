/**
 * Find the Logical ↔ Physical view toggle in the LP-model editor. The
 * top-right shows a "Logical" badge in screenshots — probe whether it's
 * a button/dropdown that switches the canvas between logical and
 * physical views.
 */
import { chromium, Page } from "playwright";
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
  const outDir = path.resolve("output", `probe_lp_toggle_${stamp}`);
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
    // Spin up an LP model (so the toggle should be present)
    await page.goto("http://questpmdmc.myerwin.com/overview", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await ensureAuthenticated(page).catch((e) => logger.warn(`auth: ${(e as Error).message}`));
    await page.waitForSelector("text=Welcome back", { timeout: 60_000 });
    await page.waitForTimeout(2000);
    await page.locator('p:text-is("New Model")').click();
    await page.waitForSelector('input[placeholder="Model Name"]', { timeout: 15_000 });
    await page.locator('input[placeholder="Model Name"]').fill(`Probe_LPview_${Date.now()}`);
    await page.locator('label:has-text("Logical/Physical")').click();
    await page.waitForSelector('input[placeholder="Database"]', { timeout: 8_000 });
    await page.locator('input[placeholder="Database"]').click();
    await page.waitForTimeout(500);
    await page.locator('li[role="option"]:has-text("Microsoft Fabric")').click();
    await page.locator('input[placeholder="Version"]').click();
    await page.waitForTimeout(500);
    await page.locator('li[role="option"]:has-text("Data Warehouse")').click();
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(15_000);
    await page.screenshot({ path: path.join(outDir, "01_editor_logical_default.png"), fullPage: true });

    // Dump every clickable element in the top-right area where the badge sits
    const dump = await page.evaluate(() => {
      const trim = (s: string | null | undefined, n = 80): string | undefined =>
        s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) || undefined : undefined;
      // Look for elements whose text matches the mode names
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], div, span'),
      );
      const matches: Array<Record<string, unknown>> = [];
      for (const el of candidates) {
        const t = (el as HTMLElement).innerText?.trim();
        if (!t) continue;
        if (/^(Logical|Physical|Logical\/Physical|Logical\s*\/\s*Physical)$/i.test(t)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          matches.push({
            tag: el.tagName,
            text: trim(t),
            ariaLabel: trim(el.getAttribute("aria-label")),
            ariaHasPopup: trim(el.getAttribute("aria-haspopup")),
            role: trim(el.getAttribute("role")),
            id: trim(el.id),
            classes: trim(typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : ""),
            x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          });
        }
      }
      return matches;
    });
    await fs.writeFile(path.join(outDir, "logical_badge_candidates.json"), JSON.stringify(dump, null, 2));
    logger.info(`found ${dump.length} candidates with text "Logical"/"Physical"`);

    // Try clicking the "Logical" badge
    const badge = page.locator(':text-is("Logical")').first();
    if ((await badge.count()) > 0) {
      try {
        await badge.click({ timeout: 3000 });
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(outDir, "02_after_logical_click.png"), fullPage: true });

        // If a menu opened, dump its options
        const menuOptions = await page.locator('li[role="option"], [role="menuitem"]').allTextContents();
        await fs.writeFile(path.join(outDir, "menu_options.json"), JSON.stringify(menuOptions, null, 2));
        logger.info(`menu options: ${JSON.stringify(menuOptions)}`);

        // Try clicking "Physical"
        const phys = page.locator(':text-is("Physical")').first();
        if ((await phys.count()) > 0) {
          await phys.click({ timeout: 3000 });
          await page.waitForTimeout(2000);
          await page.screenshot({ path: path.join(outDir, "03_physical_view.png"), fullPage: true });
        }
      } catch (e) {
        logger.warn(`badge click failed: ${(e as Error).message}`);
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
