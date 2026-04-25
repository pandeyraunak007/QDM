/**
 * Deep probe of the Reverse Engineering wizard.
 *
 * The shallow probe got us to a fully-filled form where OK stays disabled
 * and Parse Results never populates. This probe tries three things in
 * parallel:
 *   1. Use the filechooser API (Browse-button click → setFiles on the
 *      chooser) instead of direct setInputFiles, in case the React form
 *      ignores the latter.
 *   2. Log every non-asset network request + response so we can see if a
 *      parse-API call is made (and what it returns).
 *   3. Sit on the form for 60 seconds, snapping every 10s, so any delayed
 *      auto-parse or error toast becomes visible.
 *   4. Dump React-form state via [name=…] / [aria-invalid] / form data
 *      after the form is "filled" — to see if the values made it into
 *      whatever state the SPA validates against.
 */
import { chromium, Page } from "playwright";
import { existsSync, mkdirSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../utils/logger";
import { stubBrokenRuntimeConfig } from "../utils/routes";
import { ensureAuthenticated } from "../agent/auth";

const PROFILE_DIR = path.resolve(".qdm-profile");
const FIXTURE = path.resolve("fixtures/sample_schema.sql");

async function main(): Promise<void> {
  if (!existsSync(PROFILE_DIR)) throw new Error(".qdm-profile not found");
  if (!existsSync(FIXTURE)) throw new Error(`missing fixture: ${FIXTURE}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("output", `probe_re_deep_${stamp}`);
  mkdirSync(outDir, { recursive: true });
  logger.info(`output: ${outDir}`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !process.env.QDM_HEADFUL,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await stubBrokenRuntimeConfig(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => logger.warn(`pageerror: ${e.message}`));

  // Capture every interesting (non-asset) request/response.
  const network: Array<{ kind: string; method: string; url: string; status?: number; ct?: string; ts: number }> = [];
  const t0 = Date.now();
  page.on("request", (req) => {
    const u = req.url();
    if (/\.(png|jpg|svg|woff2?|ttf|ico|css)(\?|$)/.test(u)) return;
    if (/\/assets\//.test(u)) return;
    network.push({ kind: "req", method: req.method(), url: u, ts: Date.now() - t0 });
  });
  page.on("response", (resp) => {
    const u = resp.url();
    if (/\.(png|jpg|svg|woff2?|ttf|ico|css)(\?|$)/.test(u)) return;
    if (/\/assets\//.test(u)) return;
    network.push({
      kind: "resp",
      method: resp.request().method(),
      url: u,
      status: resp.status(),
      ct: resp.headers()["content-type"]?.slice(0, 80),
      ts: Date.now() - t0,
    });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      logger.warn(`console.error: ${msg.text().slice(0, 200)}`);
    }
  });

  try {
    // --- Get to the wizard ---
    await page.goto("http://questpmdmc.myerwin.com/overview", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await ensureAuthenticated(page).catch((e) => logger.warn(`auth: ${(e as Error).message}`));
    await page.waitForSelector("text=Welcome back", { timeout: 60_000 });
    await page.waitForTimeout(2000);
    await page.locator('p:text-is("Reverse Engineering")').click();
    await page.waitForSelector("text=Reverse engineer source", { timeout: 15_000 });
    await page.waitForTimeout(1500);

    // --- Switch to single page ---
    await page.locator("text=Switch to Single Page").click().catch(() => undefined);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "01_single_page.png"), fullPage: true });

    // --- Pick Script file ---
    await page.locator('label:has-text("Script file")').click();
    await page.waitForTimeout(800);

    // --- Upload via filechooser (simulate real Browse click) ---
    logger.info("uploading via filechooser API");
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator('button:has-text("Browse")').click(),
    ]);
    await chooser.setFiles(FIXTURE);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "02_after_upload.png"), fullPage: true });

    // --- Inventory all file inputs (maybe more than one — accept attr varies) ---
    const fileInputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="file"]')).map((el, i) => ({
        idx: i,
        accept: (el as HTMLInputElement).accept,
        id: el.id,
        name: (el as HTMLInputElement).name,
        files: ((el as HTMLInputElement).files
          ? Array.from((el as HTMLInputElement).files!).map((f) => ({ name: f.name, size: f.size }))
          : []),
        hidden: (el as HTMLInputElement).hidden,
        offsetParent: !!(el as HTMLElement).offsetParent,
      })),
    );
    await fs.writeFile(path.join(outDir, "all_file_inputs.json"), JSON.stringify(fileInputs, null, 2));
    logger.info(`file inputs found: ${fileInputs.length}`);

    // --- Force-set the file on every file input (cover any we missed) ---
    for (let i = 0; i < fileInputs.length; i += 1) {
      const loc = page.locator('input[type="file"]').nth(i);
      await loc.setInputFiles(FIXTURE).catch((e) => logger.warn(`setInputFiles[${i}]: ${(e as Error).message}`));
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(outDir, "02b_after_force_set_files.png"), fullPage: true });

    // --- Last-ditch: build a real File object inside the page and assign
    //     it via DataTransfer + native FileList setter, then dispatch React
    //     events. This works when Playwright's setInputFiles silently
    //     fails to wire a custom React handler. ---
    const sqlContent = await fs.readFile(FIXTURE, "utf-8");
    const fileForceSet = await page.evaluate(
      ({ content, name }) => {
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length === 0) return { ok: false, reason: "no file inputs" };
        let count = 0;
        for (const input of Array.from(inputs)) {
          const html = input as HTMLInputElement;
          const file = new File([content], name, { type: "text/plain" });
          const dt = new DataTransfer();
          dt.items.add(file);
          html.files = dt.files;
          html.dispatchEvent(new Event("input", { bubbles: true }));
          html.dispatchEvent(new Event("change", { bubbles: true }));
          count += 1;
        }
        return { ok: true, count };
      },
      { content: sqlContent, name: "sample_schema.sql" },
    );
    logger.info(`File native-set: ${JSON.stringify(fileForceSet)}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, "02c_after_native_set.png"), fullPage: true });

    // --- Fill the hidden "New Model Name" via the React-aware native-setter
    //     trick. Setting input.value directly won't trigger React's onChange;
    //     we have to call the native setter and dispatch input/change events.
    const nameSet = await page.evaluate((value) => {
      const input = document.querySelector(
        'input[placeholder="New Model Name"]',
      ) as HTMLInputElement | null;
      if (!input) return { ok: false, reason: "input not found" };
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!setter) return { ok: false, reason: "no setter" };
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, current: input.value };
    }, `RE_Deep_${Date.now()}`);
    logger.info(`Model Name set via native setter: ${JSON.stringify(nameSet)}`);
    await page.waitForTimeout(500);

    // --- Pick Database / Version ---
    await page.locator('text=Select database').click();
    await page.waitForTimeout(600);
    await page.locator('li[role="option"]:not([aria-disabled="true"])').first().click();
    await page.waitForTimeout(500);
    await page.locator('text=Select version').click();
    await page.waitForTimeout(600);
    await page.locator('li[role="option"]:not([aria-disabled="true"])').first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "03_form_filled.png"), fullPage: true });

    // --- Dump form state right after filling ---
    const formState = await page.evaluate(() => {
      const trim = (s: string | null | undefined): string | undefined =>
        s ? String(s).trim().slice(0, 100) : undefined;
      return {
        scriptInput: (document.querySelector('input[placeholder="Choose a script file..."]') as HTMLInputElement | null)?.value || null,
        fileInputFiles: (() => {
          const f = document.querySelector('input[type="file"][accept=".sql"]') as HTMLInputElement | null;
          if (!f || !f.files) return null;
          return Array.from(f.files).map((file) => ({ name: file.name, size: file.size, type: file.type }));
        })(),
        radios: Array.from(document.querySelectorAll('input[type="radio"]')).map((r) => ({
          name: trim((r as HTMLInputElement).name),
          value: trim((r as HTMLInputElement).value),
          checked: (r as HTMLInputElement).checked,
        })),
        textInputs: Array.from(document.querySelectorAll('input[type="text"]')).map((i) => ({
          placeholder: trim((i as HTMLInputElement).placeholder),
          value: trim((i as HTMLInputElement).value),
          required: (i as HTMLInputElement).required,
          disabled: (i as HTMLInputElement).disabled,
          ariaInvalid: trim(i.getAttribute("aria-invalid")),
        })),
        okButtonState: (() => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) => /^OK$/.test((b as HTMLButtonElement).innerText.trim()));
          if (!btn) return null;
          return {
            text: (btn as HTMLButtonElement).innerText,
            disabled: (btn as HTMLButtonElement).disabled,
            ariaDisabled: trim(btn.getAttribute("aria-disabled")),
          };
        })(),
        accordionExpanded: Array.from(document.querySelectorAll('[role="button"][aria-expanded]')).map((b) => ({
          text: trim((b as HTMLElement).innerText),
          expanded: trim(b.getAttribute("aria-expanded")),
        })),
      };
    });
    await fs.writeFile(path.join(outDir, "form_state_after_fill.json"), JSON.stringify(formState, null, 2));
    logger.info(`OK button: ${JSON.stringify(formState.okButtonState)}`);
    logger.info(`file input files: ${JSON.stringify(formState.fileInputFiles)}`);

    // --- Sit and snap every 10 seconds; nudge a few interactions to see if any unblocks parse ---
    const tryActions: Array<{ at: number; action: () => Promise<void>; label: string }> = [
      { at: 5_000,  action: async () => { await page.locator('text=Parse Results').click().catch(() => undefined); }, label: "click Parse Results header" },
      { at: 15_000, action: async () => { await page.mouse.click(700, 700); }, label: "click empty area" },
      { at: 25_000, action: async () => { await page.keyboard.press("Tab"); }, label: "press Tab" },
      { at: 35_000, action: async () => {
        // Toggle the section via the chevron icon
        await page.locator('[aria-expanded="false"]:has-text("Parse Results")').click().catch(() => undefined);
      }, label: "click Parse Results chevron" },
    ];

    const start = Date.now();
    let next = 0;
    while (Date.now() - start < 60_000) {
      const elapsed = Date.now() - start;
      while (next < tryActions.length && elapsed >= tryActions[next].at) {
        const action = tryActions[next];
        logger.info(`@${(elapsed / 1000).toFixed(1)}s — ${action.label}`);
        await action.action();
        next += 1;
      }
      const okState = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => /^OK$/.test((b as HTMLButtonElement).innerText.trim()));
        return btn ? !(btn as HTMLButtonElement).disabled : false;
      });
      if (okState) {
        logger.info(`@${(elapsed / 1000).toFixed(1)}s — OK is now ENABLED`);
        await page.screenshot({ path: path.join(outDir, `04_ok_enabled_${(elapsed / 1000).toFixed(0)}s.png`), fullPage: true });
        break;
      }
      const sec = Math.floor(elapsed / 5_000) * 5;
      const filename = path.join(outDir, `06_t+${String(sec).padStart(2, "0")}s.png`);
      if (!existsSync(filename)) {
        await page.screenshot({ path: filename, fullPage: true });
      }
      await page.waitForTimeout(2000);
    }

    await fs.writeFile(path.join(outDir, "network.json"), JSON.stringify(network, null, 2));
    logger.info(`captured ${network.length} non-asset network events`);

    // Filter for anything looking like a parse API call
    const parseyCalls = network.filter((n) =>
      /(parse|reverse|engineer|ddl|script)/i.test(n.url) && /^http/.test(n.url),
    );
    await fs.writeFile(path.join(outDir, "parsey_calls.json"), JSON.stringify(parseyCalls, null, 2));
    logger.info(`parse-related calls: ${parseyCalls.length}`);

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
