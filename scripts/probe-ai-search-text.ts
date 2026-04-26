/**
 * Search the DOM for any element with text matching Model Type / Database /
 * Logical / Physical / Fabric — the user reports these buttons exist
 * "below the AI page" on Overview.
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
  const outDir = path.resolve("output", `probe_ai_search_${stamp}`);
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

    // Click "Click here to get started" to expand AI panel
    await page.locator('button:has-text("Click here to get started")').first().click({ timeout: 10_000 });
    await page.waitForSelector("textarea", { timeout: 10_000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(outDir, "01_initial.png"), fullPage: true });

    // Hover over the sliders icon to see if a tooltip pops
    await page.mouse.move(220, 644);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "02_sliders_hover.png"), fullPage: false });
    const tooltips = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      for (const sel of ['[role="tooltip"]', '.MuiTooltip-tooltip', '[class*="tooltip"]', '[class*="Tooltip"]']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          out.push({ selector: sel, text: trim(el.innerText, 200), bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
        }
      }
      return out;
    })()`) as any[];
    logger.info(`tooltips after hover: ${JSON.stringify(tooltips)}`);

    // Search the entire DOM for keywords
    const matches = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const keywords = ['Model Type', 'Database', 'Logical', 'Physical', 'Fabric', 'Data Warehouse', 'Snowflake', 'PostgreSQL', 'MS SQL', 'Conceptual'];
      const out = [];
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const txt = (el.innerText || '').trim();
        if (!txt || txt.length > 200) continue;
        for (const kw of keywords) {
          if (txt.includes(kw)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            out.push({
              tag: el.tagName,
              className: (el.getAttribute('class') || '').slice(0, 100),
              role: el.getAttribute('role'),
              ariaLabel: trim(el.getAttribute('aria-label'), 100),
              text: trim(txt, 200),
              keyword: kw,
              x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
            });
            break;
          }
        }
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "03_keyword_matches.json"), JSON.stringify(matches, null, 2));
    logger.info(`keyword matches: ${matches.length}`);
    matches.slice(0, 50).forEach((m: any) => logger.info(`  ${m.tag}.${(m.className || "").slice(0, 30)} @(${m.x},${m.y}) ${m.w}x${m.h} kw=${m.keyword} text="${(m.text || "").slice(0, 80)}"`));

    // Also list all SVG icons inside the AI panel area (y 380-700)
    const aiSvgs = await page.evaluate(`(() => {
      function trim(s, n) { n = n || 200; return s ? String(s).replace(/\\s+/g, ' ').trim().slice(0, n) : undefined; }
      const out = [];
      for (const el of Array.from(document.querySelectorAll('svg'))) {
        const r = el.getBoundingClientRect();
        if (r.y < 380 || r.y > 700 || r.width < 5 || r.width > 60) continue;
        const parent = el.closest('button, [role="button"], div[class*="icon"], div[class*="Icon"]');
        const pr = parent ? parent.getBoundingClientRect() : r;
        out.push({
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          parentTag: parent && parent.tagName,
          parentClass: parent && (parent.getAttribute('class') || '').slice(0, 80),
          parentX: Math.round(pr.x), parentY: Math.round(pr.y), parentW: Math.round(pr.width), parentH: Math.round(pr.height),
          svgClass: (el.getAttribute('class') || '').slice(0, 80),
          dataTestId: trim(el.getAttribute('data-testid'), 80) || trim(parent && parent.getAttribute('data-testid'), 80),
          ariaLabel: trim(parent && parent.getAttribute('aria-label'), 100)
        });
      }
      return out;
    })()`) as any[];
    await fs.writeFile(path.join(outDir, "04_ai_svgs.json"), JSON.stringify(aiSvgs, null, 2));
    logger.info(`AI panel SVGs: ${aiSvgs.length}`);
    aiSvgs.forEach((s: any) => logger.info(`  svg @(${s.x},${s.y}) ${s.w}x${s.h} parent=${s.parentTag}.${(s.parentClass || "").slice(0, 30)} testid=${s.dataTestId || ""} aria=${s.ariaLabel || ""}`));

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
