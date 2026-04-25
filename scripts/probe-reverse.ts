/**
 * Probe the Reverse Engineering wizard.
 *
 * Click the "Reverse Engineering" Quick Action card on the Overview page
 * and dump whatever appears: dialog/wizard structure, source-type radios
 * (database connection vs. SQL file upload), input fields, and any file
 * <input type="file"> controls. Screenshot every page so we can author
 * a flow that follows the right path.
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
  const outDir = path.resolve("output", `probe_reverse_${stamp}`);
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
    await page.screenshot({ path: path.join(outDir, "01_overview.png"), fullPage: true });

    // Click "Reverse Engineering" Quick Action card.
    await page.locator('p:text-is("Reverse Engineering")').click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(outDir, "02_step1_default.png"), fullPage: true });
    await dump(page, outDir, "02_step1_default");

    // Pick Script file as the source so we can demo a SQL upload.
    await page.locator('label:has-text("Script file")').click().catch(() => undefined);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "03_script_file_picked.png"), fullPage: true });
    await dump(page, outDir, "03_script_file_picked");

    // Database / Version dropdowns are required (red asterisks). Pick the
    // only available options.
    await page.locator('input[placeholder="Select database"]').click().catch(() => undefined);
    await page.waitForTimeout(600);
    await page.locator('li[role="option"]').first().click().catch(() => undefined);
    await page.waitForTimeout(400);
    await page.locator('input[placeholder="Select version"]').click().catch(() => undefined);
    await page.waitForTimeout(600);
    await page.locator('li[role="option"]').first().click().catch(() => undefined);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, "04_dbversion_filled.png"), fullPage: true });

    // Click Next to advance through each remaining wizard step,
    // screenshotting + dumping each.
    for (let i = 1; i <= 5; i += 1) {
      const next = page.locator('button:has-text("Next")').first();
      if (!(await next.isEnabled().catch(() => false))) {
        logger.info(`Next disabled at step ${i + 1}`);
        await page.screenshot({ path: path.join(outDir, `05_step${i + 1}_blocked.png`), fullPage: true });
        await dump(page, outDir, `05_step${i + 1}_blocked`);
        break;
      }
      await next.click();
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(outDir, `06_step${i + 1}.png`), fullPage: true });
      await dump(page, outDir, `06_step${i + 1}`);
    }

    logger.info(`done: ${outDir}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function tryAdvance(page: Page, labels: string[]): Promise<boolean> {
  for (const l of labels) {
    const loc = page.locator(`button:has-text("${l}")`).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      const enabled = await loc.isEnabled().catch(() => false);
      if (enabled) {
        await loc.click().catch(() => undefined);
        return true;
      }
    }
  }
  return false;
}

async function dump(page: Page, outDir: string, label: string): Promise<void> {
  const data = await page.evaluate(() => {
    const trim = (s: string | null | undefined, n = 100): string | undefined =>
      s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) || undefined : undefined;
    const collect = (sel: string, n = 30) =>
      Array.from(document.querySelectorAll(sel)).slice(0, n).map((el) => {
        const html = el as HTMLElement & {
          name?: string;
          type?: string;
          placeholder?: string;
          value?: string;
          accept?: string;
          multiple?: boolean;
        };
        return {
          tag: el.tagName,
          role: trim(el.getAttribute("role"), 30),
          ariaLabel: trim(el.getAttribute("aria-label"), 80),
          ariaHasPopup: trim(el.getAttribute("aria-haspopup"), 20),
          placeholder: trim(html.placeholder, 80),
          name: trim(html.name, 60),
          id: trim(html.id, 60),
          type: trim(html.type, 30),
          value: trim(html.value, 60),
          text: trim(html.innerText, 80),
          accept: trim(html.accept, 100),
          multiple: html.multiple || undefined,
        };
      });
    return {
      title: document.title,
      url: location.href,
      inputs: collect("input, textarea, select"),
      buttons: collect('button, [role="button"], input[type="submit"]', 50),
      labels_radios: collect('label, input[type="radio"], input[type="checkbox"]', 30),
      file_inputs: collect('input[type="file"]', 10),
      modals: collect('[role="dialog"]', 5),
      headings: Array.from(document.querySelectorAll("h1, h2, h3, h4")).slice(0, 20).map((el) => ({
        tag: el.tagName,
        text: trim((el as HTMLElement).innerText, 80),
      })),
    };
  });
  await fs.writeFile(path.join(outDir, `${label}_dump.json`), JSON.stringify(data, null, 2), "utf-8");
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
