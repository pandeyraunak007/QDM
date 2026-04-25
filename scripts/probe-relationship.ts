/**
 * Diagnose why "Add Relationships → drag" doesn't visibly create a line.
 *
 * Plan:
 *   1. Create a fresh probe model with two entities (Customer, Orders).
 *   2. Find the entity nodes on the canvas (DOM/SVG/HTML) and dump their
 *      bounding boxes, classes, listeners — so we know where the drag
 *      source/target should land.
 *   3. Activate the Add Relationships tool and try several drag styles,
 *      screenshotting after each:
 *        a. fast straight drag, body→body  (current behaviour)
 *        b. slow drag, more steps, body→body
 *        c. drag with mouseDown delay before moving
 *        d. simple two-click (source then target) without drag
 *      Each attempt is reset between tries by undoing or refreshing,
 *      and the screenshot of the canvas after the gesture is saved.
 *
 * Run:  QDM_USER=... QDM_PASS=... npx ts-node scripts/probe-relationship.ts
 */
import { chromium, Page, BrowserContext } from "playwright";
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
  const outDir = path.resolve("output", `probe_relationship_${stamp}`);
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
    await setupEditorWithEntities(page);
    await page.screenshot({ path: path.join(outDir, "10_two_entities.png"), fullPage: true });

    // The canvas is rendered via HTML5 <canvas>; entity labels are pixel
    // text, not DOM nodes — Playwright can't bounding-box them. We placed
    // the entities at known viewport coordinates, so use those directly.
    const customer = { x: 620, y: 358, w: 160, h: 64, text: "Customer" };
    const orders   = { x: 970, y: 358, w: 160, h: 64, text: "Orders" };
    await fs.writeFile(
      path.join(outDir, "entities.json"),
      JSON.stringify({ customer, orders, note: "hardcoded — canvas is <canvas>" }, null, 2),
    );

    const summary: string[] = [];

    // ─── Strategy A: fast drag body→body (current production behaviour) ───
    await activateRelationshipsTool(page);
    await dragBetween(page, customer, orders, { steps: 18, holdMs: 0 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "20_strategy_A_fast.png"), fullPage: true });
    summary.push(`A fast drag (18 steps, body→body)`);

    await resetTool(page);

    // ─── Strategy B: slow drag with many steps + initial hold ───
    await activateRelationshipsTool(page);
    await dragBetween(page, customer, orders, { steps: 60, holdMs: 250 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "21_strategy_B_slow.png"), fullPage: true });
    summary.push(`B slow drag (60 steps, 250ms hold, body→body)`);

    await resetTool(page);

    // ─── Strategy C: simple two-click ───
    await activateRelationshipsTool(page);
    await page.mouse.click(centerX(customer), centerY(customer));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "22_strategy_C_after_first_click.png"), fullPage: true });
    await page.mouse.click(centerX(orders), centerY(orders));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "23_strategy_C_after_second_click.png"), fullPage: true });
    summary.push(`C click-click on bodies`);

    await resetTool(page);

    // ─── Strategy D: drag from right edge of source to left edge of target ───
    await activateRelationshipsTool(page);
    const srcRight = { x: customer.x + customer.w - 8, y: customer.y + customer.h / 2, w: 1, h: 1 } as const;
    const tgtLeft  = { x: orders.x + 8,                y: orders.y   + orders.h / 2,   w: 1, h: 1 } as const;
    await dragBetween(page, srcRight as any, tgtLeft as any, { steps: 50, holdMs: 200 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "24_strategy_D_edge_to_edge.png"), fullPage: true });
    summary.push(`D drag from src right edge to tgt left edge`);

    await resetTool(page);

    // ─── Strategy E: drag starting from the "+" handle at the top-right ───
    // The "+" icon visible in screenshots sits roughly at (right - 12, top + 12).
    await activateRelationshipsTool(page);
    const plusHandle = { x: customer.x + customer.w - 12, y: customer.y + 12, w: 1, h: 1 } as const;
    const ordersBody = { x: orders.x + orders.w / 2,      y: orders.y   + orders.h / 2, w: 1, h: 1 } as const;
    await dragBetween(page, plusHandle as any, ordersBody as any, { steps: 50, holdMs: 200 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "25_strategy_E_plus_handle.png"), fullPage: true });
    summary.push(`E drag from src "+" handle to tgt body`);

    await resetTool(page);

    // ─── Strategy G: pick a subtype FIRST (Non-Identifying), then drag ───
    // The Add Relationships button is a dropdown trigger; clicking it opens
    // a menu of subtypes (Sub-Category / Identifying / Non-Identifying /
    // Many-to-Many). We were ignoring the menu and the drag was a no-op.
    await page.locator('[aria-label="Add Relationships"]').click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, "30_strategy_G_menu_open.png"), fullPage: true });
    await page.locator(':text-is("Non-Identifying")').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, "31_strategy_G_subtype_picked.png"), fullPage: true });
    await dragBetween(page, customer, orders, { steps: 50, holdMs: 200 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "32_strategy_G_after_drag.png"), fullPage: true });
    summary.push(`G pick Non-Identifying then drag (THIS SHOULD WORK)`);

    await resetTool(page);

    // ─── Strategy F: hover first, then slow drag (some libs surface a handle on hover) ───
    await activateRelationshipsTool(page);
    await page.mouse.move(centerX(customer), centerY(customer));
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, "26_strategy_F_hover.png"), fullPage: true });
    await page.mouse.down();
    await page.waitForTimeout(400);
    await slowMove(page, centerX(customer), centerY(customer), centerX(orders), centerY(orders), 50);
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "27_strategy_F_after_drag.png"), fullPage: true });
    summary.push(`F hover-then-slow-drag (400ms hold + 50 steps)`);

    await fs.writeFile(path.join(outDir, "_summary.txt"), summary.join("\n") + "\n", "utf-8");
    logger.info(`done: ${outDir}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function setupEditorWithEntities(page: Page): Promise<void> {
  await page.goto("http://questpmdmc.myerwin.com/overview", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  await ensureAuthenticated(page).catch((e) => logger.warn(`auth: ${(e as Error).message}`));
  await page.waitForSelector("text=Welcome back", { timeout: 60_000 });
  await page.waitForTimeout(2000);
  await page.locator('p:text-is("New Model")').click();
  await page.waitForSelector('input[placeholder="Model Name"]', { timeout: 15_000 });
  await page
    .locator('input[placeholder="Model Name"]')
    .fill(`Probe_Rel_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`);
  await page.locator('label:has-text("Logical"):not(:has-text("/"))').click();
  await page.locator('button:has-text("Create")').click();
  await page.waitForTimeout(15_000);

  // Place Customer
  await page.locator('[aria-label="Add Entity"]').click();
  await page.waitForTimeout(800);
  await page.mouse.click(700, 400);
  await page.waitForSelector("input#table-name", { timeout: 10_000 });
  await page.locator("input#table-name").fill("Customer");
  await page.locator("input#table-name").press("Tab");
  await page.mouse.click(200, 750);
  await page.waitForTimeout(1500);

  // Place Orders
  await page.locator('[aria-label="Add Entity"]').click();
  await page.waitForTimeout(800);
  await page.mouse.click(1050, 400);
  await page.waitForSelector("input#table-name", { timeout: 10_000 });
  await page.locator("input#table-name").fill("Orders");
  await page.locator("input#table-name").press("Tab");
  await page.mouse.click(200, 750);
  await page.waitForTimeout(1500);
}

interface EntityGeometry {
  tag?: string;
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  classes?: string;
  selector?: string;
}

type Pt = { x: number; y: number; w: number; h: number };

async function dumpEntityGeometry(page: Page): Promise<EntityGeometry[]> {
  return page.evaluate((): EntityGeometry[] => {
    const trim = (s: string | null | undefined, n = 100): string | undefined =>
      s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) || undefined : undefined;
    const seen = new Set<Element>();
    const results: EntityGeometry[] = [];

    // Look for elements whose text content matches "Customer" or "Orders" —
    // these are the entity title bars. Walk up to a parent that looks like
    // a self-contained entity node (sized roughly like a card).
    const candidates = Array.from(document.querySelectorAll("*")).filter((el) => {
      const t = (el as HTMLElement).innerText?.trim();
      return t === "Customer" || t === "Orders";
    });

    for (const titleEl of candidates) {
      let el: Element | null = titleEl;
      for (let depth = 0; depth < 6 && el; depth += 1, el = el.parentElement) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 100 && r.height > 50 && r.width < 400 && r.height < 250) {
          if (seen.has(el)) break;
          seen.add(el);
          results.push({
            tag: el.tagName,
            text: trim((el as HTMLElement).innerText, 60),
            x: r.left,
            y: r.top,
            w: Math.round(r.width),
            h: Math.round(r.height),
            classes: trim(typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : ""),
          });
          break;
        }
      }
    }
    return results;
  });
}

function centerX(g: Pt): number { return g.x + g.w / 2; }
function centerY(g: Pt): number { return g.y + g.h / 2; }

async function activateRelationshipsTool(page: Page): Promise<void> {
  await page.locator('[aria-label="Add Relationships"]').click();
  await page.waitForTimeout(500);
}

async function resetTool(page: Page): Promise<void> {
  // Clicking Select again returns the cursor to selection mode and clears
  // any in-progress relationship.
  await page.locator('[aria-label="Select"]').click().catch(() => undefined);
  await page.waitForTimeout(400);
  // Press Escape to dismiss any in-flight rubber-band line
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
}

async function dragBetween(
  page: Page,
  src: Pt,
  tgt: Pt,
  opts: { steps: number; holdMs: number },
): Promise<void> {
  const sx = centerX(src), sy = centerY(src);
  const tx = centerX(tgt), ty = centerY(tgt);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  if (opts.holdMs > 0) await page.waitForTimeout(opts.holdMs);
  await slowMove(page, sx, sy, tx, ty, opts.steps);
  await page.mouse.up();
}

async function slowMove(page: Page, sx: number, sy: number, tx: number, ty: number, steps: number): Promise<void> {
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = sx + (tx - sx) * t;
    const y = sy + (ty - sy) * t;
    await page.mouse.move(x, y);
    // Brief pause so the diagram engine sees a real-feeling motion event
    await page.waitForTimeout(15);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
