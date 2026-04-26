/**
 * Two-part probe:
 *  1. Pick Logical/Physical on the AI Model Generator and verify chip persists.
 *  2. Open an existing LP model and capture the right-side "Describe changes"
 *     conversation panel — selector, send button, message structure.
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
  const outDir = path.resolve("output", `probe_ai_feature_${stamp}`);
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

    // ============== PART 1: LP selection ==============
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

    // Inspect popover radio inputs
    const radios = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 100; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      for (const inp of Array.from(document.querySelectorAll('input[type="radio"]'))) {
        const r = inp.getBoundingClientRect();
        if (r.width === 0) continue;
        const lblFor = inp.id ? document.querySelector('label[for="' + inp.id + '"]') : null;
        const parentLabel = inp.closest('label');
        out.push({
          id: trim(inp.id, 80),
          name: trim(inp.name, 80),
          value: trim(inp.value, 80),
          checked: inp.checked,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          forLabelText: trim(lblFor && lblFor.innerText, 80),
          parentLabelText: trim(parentLabel && parentLabel.innerText, 80)
        });
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "01_radios.json"), JSON.stringify(radios, null, 2));
    logger.info(`radios: ${radios.length}`);
    radios.forEach((r: any) => logger.info(`  id=${r.id} name=${r.name} value=${r.value} checked=${r.checked} bbox=(${r.x},${r.y}) labelText="${r.forLabelText || r.parentLabelText}"`));

    // Click LP via JS dispatch on the radio input itself
    const clicked = await page.evaluate(`(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const target = radios.find(function(r) { return (r.value || '').toUpperCase() === 'LOGICAL/PHYSICAL'; });
      if (!target) return { ok: false, reason: 'no LOGICAL/PHYSICAL radio' };
      target.click();
      return { ok: true, value: target.value, checked: target.checked };
    })()`) as any;
    logger.info(`LP click result: ${JSON.stringify(clicked)}`);
    await page.waitForTimeout(1000);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "02_after_lp_select.png"), fullPage: false });

    // Check if chip appears in the AI panel footer
    const chipsInfo = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 100; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      const all = Array.from(document.querySelectorAll('div, span, button, [role="button"]'));
      for (const el of all) {
        const t = trim(el.innerText, 50) || '';
        if (/^(Logical\\/Physical|Microsoft Fabric|Data Warehouse|Logical|Physical|Conceptual)$/i.test(t.trim())) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.y > 700 || r.y < 280) continue;
          out.push({ tag: el.tagName, text: t, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      return out;
    })()`) as any[];
    logger.info(`chip candidates near AI panel: ${chipsInfo.length}`);
    chipsInfo.forEach((c: any) => logger.info(`  ${c.tag} @(${c.x},${c.y}) ${c.w}x${c.h} "${c.text}"`));
    await fs.writeFile(path.join(outDir, "02_chips.json"), JSON.stringify(chipsInfo, null, 2));

    // ============== PART 2: Open MFW_LP_TEST and find AI conversation panel ==============
    await page.locator('button:has-text("Cancel")').first().click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1500);

    const link = page.locator('span:text-is("MFW_LP_TEST")').first();
    await link.scrollIntoViewIfNeeded();
    await link.dblclick({ timeout: 10_000, force: true });
    await page.waitForURL(/modeler/i, { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(8000);
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(outDir, "10_modeler.png"), fullPage: false });

    // Look for any element that opens the AI panel — usually a chat icon in the right rail
    const rightRailDump = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 100; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      const all = Array.from(document.querySelectorAll('button, [role="button"], svg, div'));
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.x < 1380 || r.y < 100 || r.y > 800 || r.width === 0) continue;
        if (r.width > 60 || r.height > 60) continue;
        out.push({
          tag: el.tagName,
          aria: trim(el.getAttribute('aria-label'), 100),
          title: trim(el.getAttribute('title'), 100),
          dataTestId: trim(el.getAttribute('data-testid'), 100),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
        });
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "11_right_rail.json"), JSON.stringify(rightRailDump, null, 2));
    logger.info(`right rail icons: ${rightRailDump.length}`);
    rightRailDump.forEach((r: any) => logger.info(`  ${r.tag} @(${r.x},${r.y}) ${r.w}x${r.h} aria="${r.aria || ""}" title="${r.title || ""}" testid="${r.dataTestId || ""}"`));

    // Click each right-rail icon and screenshot
    for (let i = 0; i < Math.min(rightRailDump.length, 6); i++) {
      const r: any = rightRailDump[i];
      logger.info(`clicking right-rail icon #${i} @(${r.x},${r.y}) aria="${r.aria || ""}"`);
      try {
        await page.mouse.click(r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2));
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(outDir, `12_icon_${i}_${r.x}_${r.y}.png`), fullPage: false });

        // Check if a "Describe changes" textarea appeared
        const aiInput = await page.evaluate(`(() => {
          function trim(s, n) { n = n || 100; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
          const out = [];
          for (const el of Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]'))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            out.push({
              tag: el.tagName,
              placeholder: trim(el.getAttribute('placeholder'), 100),
              x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
            });
          }
          return out;
        })()`) as any[];
        const matches = aiInput.filter((i: any) => /describe|changes|chat|message|prompt|ask/i.test(i.placeholder || ""));
        if (matches.length > 0) {
          logger.info(`  FOUND AI input(s): ${JSON.stringify(matches)}`);
          await fs.writeFile(path.join(outDir, `12_icon_${i}_ai_inputs.json`), JSON.stringify(aiInput, null, 2));
        }
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
