/**
 * Find the Forward Engineering / Schema Generation entry point in the QDM
 * editor. From the toolbar dump we have Tools, Mart, Download, etc. — FE
 * is usually under one of those. Open an existing model with attributes
 * (so FE has something interesting to generate), then click each likely
 * menu and dump what shows up.
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
  const outDir = path.resolve("output", `probe_forward_${stamp}`);
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

    // Open an existing model with real attributes. "HR Career Management
    // By Bilel" has 18 entities + 204 attributes — most interesting target
    // for FE. Fall back to Customer Order Model if the click fails.
    logger.info("opening a Recent Model");
    // Faster path than navigating the Catalog Manager: create a fresh LP
    // model inline. Same shortcut the LP flow uses.
    logger.info("creating a fresh LP model for the probe");
    await page.locator('p:text-is("New Model")').click();
    await page.waitForSelector('input[placeholder="Model Name"]', { timeout: 15_000 });
    await page.locator('input[placeholder="Model Name"]').fill(`Probe_FE_${Date.now()}`);
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
    await page.screenshot({ path: path.join(outDir, "02_editor_open.png"), fullPage: true });

    // Place a couple of entities so FE has something to generate
    for (const [name, x] of [["Customer", 700], ["Orders", 1050]] as const) {
      await page.locator('[aria-label="Add Entity"]').click();
      await page.waitForTimeout(700);
      await page.mouse.click(x, 400);
      await page.waitForSelector("input#table-name", { timeout: 10_000 });
      await page.locator("input#table-name").fill(name);
      await page.locator("input#table-name").press("Tab");
      await page.mouse.click(200, 750);
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: path.join(outDir, "02b_entities_placed.png"), fullPage: true });
    await page.screenshot({ path: path.join(outDir, "02_editor_open.png"), fullPage: true });

    // Snapshot every clickable option in each likely menu.
    const menus: Array<{ name: string; selector: string; itemCount?: number; items?: string[] }> = [];

    for (const m of [
      { name: "Download", selector: '[aria-label="Select Download or Print"]' },
      { name: "Tools",    selector: '[aria-label="Tools"]' },
      { name: "Mart",     selector: '[aria-label="Mart"]' },
      { name: "Editors",  selector: '[aria-label="Editors"]' },
      { name: "Actions",  selector: '[aria-label*="ction"]' },
    ]) {
      const trigger = page.locator(m.selector).first();
      if ((await trigger.count()) === 0) {
        logger.warn(`${m.name}: no trigger found (${m.selector})`);
        menus.push({ name: m.name, selector: m.selector });
        continue;
      }
      try {
        await trigger.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        await page.screenshot({
          path: path.join(outDir, `03_menu_${m.name.toLowerCase()}.png`),
          fullPage: true,
        });
        // Capture menu items — typical MUI menus use [role="menuitem"]
        const items = await page.locator('[role="menuitem"], li[role="option"]').allTextContents();
        menus.push({ name: m.name, selector: m.selector, itemCount: items.length, items });
        logger.info(`${m.name}: ${items.length} items — ${items.join(" | ").slice(0, 200)}`);
        // Close the menu
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        // Some menus are click-toggle; click outside as a fallback
        await page.mouse.click(50, 50).catch(() => undefined);
        await page.waitForTimeout(400);
      } catch (e) {
        logger.warn(`${m.name} click failed: ${(e as Error).message}`);
        menus.push({ name: m.name, selector: m.selector });
      }
    }

    await fs.writeFile(path.join(outDir, "menus.json"), JSON.stringify(menus, null, 2));

    // --- Switch to Physical view and re-probe ---
    logger.info("switching to Physical view");
    await page.locator(':text-is("Logical")').first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    await page.locator(':text-is("Physical")').first().click().catch(() => undefined);
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: path.join(outDir, "04_physical_view.png"), fullPage: true });

    const physMenus: typeof menus = [];
    for (const m of [
      { name: "Download", selector: '[aria-label="Select Download or Print"]' },
      { name: "Tools",    selector: '[aria-label="Tools"]' },
      { name: "Mart",     selector: '[aria-label="Mart"]' },
      { name: "Editors",  selector: '[aria-label="Editors"]' },
    ]) {
      const trigger = page.locator(m.selector).first();
      if ((await trigger.count()) === 0) continue;
      try {
        await trigger.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        await page.screenshot({
          path: path.join(outDir, `05_phys_menu_${m.name.toLowerCase()}.png`),
          fullPage: true,
        });
        const items = await page.locator('[role="menuitem"], li[role="option"]').allTextContents();
        physMenus.push({ name: m.name, selector: m.selector, itemCount: items.length, items });
        logger.info(`[Physical] ${m.name}: ${items.join(" | ").slice(0, 200)}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        await page.mouse.click(50, 50).catch(() => undefined);
        await page.waitForTimeout(400);
      } catch (e) {
        logger.warn(`[Physical] ${m.name}: ${(e as Error).message}`);
      }
    }
    await fs.writeFile(path.join(outDir, "menus_physical.json"), JSON.stringify(physMenus, null, 2));

    // Click Forward Engineering and dump whatever wizard appears
    logger.info("clicking Forward Engineering");
    await page.locator('[aria-label="Tools"]').click();
    await page.waitForTimeout(700);
    await page.locator(':text-is("Forward Engineering")').click();
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: path.join(outDir, "08_fe_wizard.png"), fullPage: true });

    const feShape = await page.evaluate(() => {
      const trim = (s: string | null | undefined, n = 100): string | undefined =>
        s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) || undefined : undefined;
      return {
        title: document.title,
        url: location.href,
        headings: Array.from(document.querySelectorAll("h1, h2, h3, h4, h5")).slice(0, 20).map((el) => trim((el as HTMLElement).innerText, 80)).filter(Boolean),
        buttons: Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 50).map((el) => ({
          text: trim((el as HTMLElement).innerText, 60),
          ariaLabel: trim(el.getAttribute("aria-label"), 60),
          disabled: (el as HTMLButtonElement).disabled,
        })).filter((b) => b.text || b.ariaLabel),
        inputs: Array.from(document.querySelectorAll("input, textarea, select")).slice(0, 30).map((el) => ({
          tag: el.tagName,
          type: (el as HTMLInputElement).type,
          placeholder: trim((el as HTMLInputElement).placeholder),
          name: trim((el as HTMLInputElement).name),
          value: trim((el as HTMLInputElement).value),
        })),
      };
    });
    await fs.writeFile(path.join(outDir, "fe_wizard_shape.json"), JSON.stringify(feShape, null, 2));
    logger.info(`FE wizard headings: ${feShape.headings.join(" | ")}`);

    // Try right-clicking on the canvas + on a sidebar item
    logger.info("right-clicking on Schemas in Model Explorer (if visible)");
    const schemas = page.locator(':text-is("Schemas")').first();
    if ((await schemas.count()) > 0) {
      await schemas.click({ button: "right" }).catch(() => undefined);
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(outDir, "06_phys_schemas_rclick.png"), fullPage: true });
    }
    // Also try Tables right-click
    const tables = page.locator(':text-is("Tables")').first();
    if ((await tables.count()) > 0) {
      await tables.click({ button: "right" }).catch(() => undefined);
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(outDir, "07_phys_tables_rclick.png"), fullPage: true });
    }

    // Also do a generic page-text scan for "Forward Engineer" / "Generate"
    const fwdHits = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      const matches: Array<{ tag: string; text: string }> = [];
      for (const el of all) {
        const t = (el as HTMLElement).innerText?.trim();
        if (!t) continue;
        if (t.length > 100) continue;
        if (/forward.?engineer|generate.?(ddl|schema|sql)|schema.?gener/i.test(t)) {
          matches.push({ tag: el.tagName, text: t.slice(0, 80) });
        }
      }
      return matches.slice(0, 20);
    });
    await fs.writeFile(path.join(outDir, "fwd_text_hits.json"), JSON.stringify(fwdHits, null, 2));
    logger.info(`forward-engineer text hits: ${fwdHits.length}`);

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
