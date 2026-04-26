/**
 * Open the LP-test model and find Forward Engineering UI.
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
  const outDir = path.resolve("output", `probe_fe_${stamp}`);
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
    await page.screenshot({ path: path.join(outDir, "01_overview.png"), fullPage: true });

    // Try via dispatchEvent click on the parent row's clickable element
    // First, find what element MFW_LP_TEST is and what its parent stack looks like
    const info = await page.evaluate(`(() => {
      const sp = Array.from(document.querySelectorAll('span')).find(function(s) { return (s.textContent || '').trim() === 'MFW_LP_TEST'; });
      if (!sp) return null;
      const result = [];
      let el = sp;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        const r = el.getBoundingClientRect();
        result.push({
          tag: el.tagName, className: (el.getAttribute('class') || '').slice(0, 100),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          hasClick: !!el.onclick
        });
        el = el.parentElement;
      }
      return result;
    })()`) as any[];
    logger.info(`MFW_LP_TEST ancestor chain: ${JSON.stringify(info, null, 2)}`);

    // Try double-click
    const link = page.locator('span:text-is("MFW_LP_TEST")').first();
    await link.scrollIntoViewIfNeeded();
    await link.dblclick({ timeout: 10_000, force: true });
    await page.waitForURL(/modeler/i, { timeout: 30_000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(8000);
    logger.info(`url after dblclick: ${page.url()}`);
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(outDir, "02_modeler_loaded.png"), fullPage: true });

    // Look for menus / toolbar buttons
    const buttons = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 100; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      return Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]')).slice(0, 200).map(function(el) {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          text: trim(el.innerText, 80),
          aria: trim(el.getAttribute('aria-label'), 100),
          testid: trim(el.getAttribute('data-testid'), 80),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0
        };
      }).filter(function(b) { return b.visible && (b.text || b.aria || b.testid); });
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "02_buttons.json"), JSON.stringify(buttons, null, 2));

    const fwd = buttons.filter((b: any) => /forward|engineer|generate|sql|export/i.test(`${b.text || ""} ${b.aria || ""} ${b.testid || ""}`));
    logger.info(`forward-related buttons: ${fwd.length}`);
    fwd.forEach((b: any) => logger.info(`  ${b.tag} @(${b.x},${b.y}) text="${b.text || ""}" aria="${b.aria || ""}" testid="${b.testid || ""}"`));

    // Find top-bar menu items: File, Edit, View, Tools, etc.
    const menus = buttons.filter((b: any) => /^(File|Edit|View|Tools|Insert|Help|Export)$/i.test((b.text || "").trim()));
    logger.info(`top-bar menus: ${menus.length}`);
    menus.forEach((b: any) => logger.info(`  ${b.tag} @(${b.x},${b.y}) text="${b.text || ""}"`));

    // Click the bottom-toolbar "Tools" button (aria="Tools")
    const toolsBtn = page.locator('[aria-label="Tools"]').first();
    await toolsBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "03_tools_menu.png"), fullPage: false });
    const toolItems = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      for (const sel of ['[role="menu"]', '.MuiMenu-paper', '.MuiPopover-paper', '[role="listbox"]']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          out.push({
            selector: sel,
            bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            items: Array.from(el.querySelectorAll('[role="menuitem"], li, button')).slice(0, 40).map(function(it) {
              const rr = it.getBoundingClientRect();
              return { text: trim(it.innerText, 100), x: Math.round(rr.x), y: Math.round(rr.y), aria: trim(it.getAttribute('aria-label'), 80) };
            }).filter(function(x) { return x.text || x.aria; })
          });
        }
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "03_tools_menu.json"), JSON.stringify(toolItems, null, 2));
    logger.info(`tools menu popovers: ${toolItems.length}`);

    // Click "Forward Engineering"
    await page.locator('[role="menuitem"]:has-text("Forward Engineering")').first().click({ timeout: 5000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(outDir, "04_fe_wizard.png"), fullPage: true });

    // Walk through the wizard — capture every step
    for (let step = 1; step <= 8; step++) {
      const state = await page.evaluate(`(() => {
        function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).map(function(el) { return trim(el.innerText, 200); }).filter(Boolean);
        const buttons = Array.from(document.querySelectorAll('button:not([disabled])')).slice(0, 50).map(function(el) {
          const r = el.getBoundingClientRect();
          return { text: trim(el.innerText, 100), aria: trim(el.getAttribute('aria-label'), 100), x: Math.round(r.x), y: Math.round(r.y), visible: r.width > 0 && r.height > 0 };
        }).filter(function(x) { return x.visible && (x.text || x.aria); });
        const inputs = Array.from(document.querySelectorAll('input, select, textarea, [role="combobox"]')).slice(0, 30).map(function(el) {
          return { tag: el.tagName, type: el.getAttribute('type'), placeholder: trim(el.getAttribute('placeholder'), 80), value: trim(el.value, 80), name: trim(el.getAttribute('name'), 80) };
        }).filter(function(x) { return x.placeholder || x.value || x.name; });
        return { headings: headings, buttons: buttons, inputs: inputs };
      })()`) as any;
      await fs.writeFile(path.join(outDir, `05_wizard_step_${step}.json`), JSON.stringify(state, null, 2));
      logger.info(`wizard step ${step}: headings=${state.headings.slice(0, 3).join(" | ")}`);
      logger.info(`  buttons: ${state.buttons.map((b: any) => b.text).filter(Boolean).slice(0, 12).join(" | ")}`);

      // Find Next button
      const nextBtn = state.buttons.find((b: any) => /^Next$/i.test(b.text || ""));
      const previewBtn = state.buttons.find((b: any) => /Preview|Generate/i.test(b.text || ""));
      const finishBtn = state.buttons.find((b: any) => /^(Finish|Done|Close|Cancel)$/i.test(b.text || ""));
      const target = nextBtn || previewBtn;
      if (!target) {
        logger.info(`  no Next/Preview button — wizard may be at preview/end. Buttons: ${state.buttons.map((b: any) => b.text).filter(Boolean).join(" | ")}`);
        break;
      }
      logger.info(`  clicking "${target.text}" at (${target.x}, ${target.y})`);
      await page.mouse.click(target.x + 30, target.y + 15);
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(outDir, `06_after_step_${step}.png`), fullPage: true });
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
