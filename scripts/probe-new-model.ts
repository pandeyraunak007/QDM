/**
 * Open the New Model dialog with "Logical/Physical" selected and dump the
 * Database / Version dropdown options + their selectors so we can wire
 * them into the LP flow.
 *
 *   QDM_USER=... QDM_PASS=... npx ts-node scripts/probe-new-model.ts
 */
import { chromium } from "playwright";
import * as fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { stubBrokenRuntimeConfig } from "../utils/routes";
import { ensureAuthenticated } from "../agent/auth";

const PROFILE_DIR = path.resolve(".qdm-profile");

async function main(): Promise<void> {
  if (!existsSync(PROFILE_DIR)) throw new Error(".qdm-profile not found");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("output", `probe_new_model_${stamp}`);
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
    await page.goto("http://questpmdmc.myerwin.com/overview", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await ensureAuthenticated(page).catch((e) => logger.warn(`auth: ${(e as Error).message}`));

    await page.waitForSelector("text=Welcome back", { timeout: 60_000 });
    await page.waitForTimeout(2000);
    await page.locator('p:text-is("New Model")').click();
    await page.waitForSelector('input[placeholder="Model Name"]', { timeout: 15_000 });

    await page.screenshot({ path: path.join(outDir, "01_dialog_default.png"), fullPage: true });

    // Fill name + click Logical/Physical
    await page.locator('input[placeholder="Model Name"]').fill("Probe_LP");
    await page.locator('label:has-text("Logical/Physical")').click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "02_lp_selected.png"), fullPage: true });
    await dump(page, outDir, "lp_selected");

    // Try opening the Database dropdown via a few selector strategies.
    const candidates = [
      'input[placeholder="Database"]',
      'div[role="combobox"]:has-text("Database")',
      ':text("Database") >> xpath=ancestor::*[@role="combobox"][1]',
      'label:has-text("Database")',
    ];
    let opened = false;
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          logger.info(`trying Database trigger: ${sel}`);
          await loc.click();
          await page.waitForTimeout(700);
          const optionCount = await page.locator('li[role="option"]').count();
          if (optionCount > 0) {
            opened = true;
            await page.screenshot({ path: path.join(outDir, "03_db_dropdown.png"), fullPage: true });
            const options = await page.locator('li[role="option"]').allTextContents();
            await fs.writeFile(
              path.join(outDir, "db_options.json"),
              JSON.stringify({ trigger: sel, options }, null, 2),
            );
            logger.info(`opened with ${sel} → ${optionCount} options`);
            // Pick the first option to enable Version
            await page.locator('li[role="option"]').first().click();
            await page.waitForTimeout(600);
            await page.screenshot({ path: path.join(outDir, "04_db_picked.png"), fullPage: true });
            await dump(page, outDir, "db_picked");
            break;
          }
          // Close any popover before trying next
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(300);
        }
      } catch (err) {
        logger.warn(`selector failed ${sel}: ${(err as Error).message}`);
      }
    }
    if (!opened) {
      logger.warn("could not open Database dropdown with any candidate selector");
    }

    // Now try the Version dropdown.
    const versionCandidates = [
      'input[placeholder="Version"]',
      'div[role="combobox"]:has-text("Version")',
    ];
    for (const sel of versionCandidates) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          await loc.click();
          await page.waitForTimeout(700);
          const optionCount = await page.locator('li[role="option"]').count();
          if (optionCount > 0) {
            await page.screenshot({ path: path.join(outDir, "05_version_dropdown.png"), fullPage: true });
            const options = await page.locator('li[role="option"]').allTextContents();
            await fs.writeFile(
              path.join(outDir, "version_options.json"),
              JSON.stringify({ trigger: sel, options }, null, 2),
            );
            logger.info(`Version: opened with ${sel} → ${optionCount} options`);
            break;
          }
          await page.keyboard.press("Escape").catch(() => undefined);
        }
      } catch {
        /* try next */
      }
    }

    logger.info(`done: ${outDir}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function dump(page: import("playwright").Page, outDir: string, label: string): Promise<void> {
  const data = await page.evaluate(() => {
    const trim = (s: string | null | undefined, n = 80): string | undefined =>
      s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) || undefined : undefined;
    const collect = (sel: string) =>
      Array.from(document.querySelectorAll(sel)).slice(0, 30).map((el) => {
        const html = el as HTMLElement & { name?: string; type?: string; placeholder?: string; value?: string };
        return {
          tag: el.tagName,
          role: trim(el.getAttribute("role"), 30),
          ariaLabel: trim(el.getAttribute("aria-label"), 60),
          ariaExpanded: trim(el.getAttribute("aria-expanded"), 10),
          ariaHasPopup: trim(el.getAttribute("aria-haspopup"), 20),
          placeholder: trim(html.placeholder, 60),
          name: trim(html.name, 60),
          id: trim(html.id, 60),
          type: trim(html.type, 30),
          value: trim(html.value, 60),
          text: trim(html.innerText, 80),
        };
      });
    return {
      inputs: collect("input"),
      comboboxes: collect('[role="combobox"], [role="button"][aria-haspopup]'),
    };
  });
  await fs.writeFile(path.join(outDir, `${label}_dump.json`), JSON.stringify(data, null, 2), "utf-8");
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
