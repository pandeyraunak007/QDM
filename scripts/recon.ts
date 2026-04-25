/**
 * Read-only reconnaissance for a Quest Data Modeler instance.
 *
 * Loads the configured URL, optionally logs in, captures full-page
 * screenshots at each stage, and dumps a JSON summary of input/button/link
 * elements so real selectors can be discovered for the flow JSON files.
 *
 * Credentials are read from env vars only — never commit them.
 *
 *   QDM_URL=http://... QDM_USER=... QDM_PASS=... npx ts-node scripts/recon.ts
 */
import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { stubBrokenRuntimeConfig } from "../utils/routes";

const DEFAULT_PROFILE_DIR = ".qdm-profile";

interface ElementInfo {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  text?: string;
  classes?: string;
  dataTestId?: string;
}

interface PageDump {
  title: string;
  url: string;
  inputs: ElementInfo[];
  buttons: ElementInfo[];
  links: Array<{ href: string; text: string }>;
}

async function main(): Promise<void> {
  const url = requireEnv("QDM_URL");
  const user = process.env.QDM_USER;
  const pass = process.env.QDM_PASS;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("output", `recon_${stamp}`);
  await fs.mkdir(outDir, { recursive: true });

  logger.info(`recon URL: ${url}`);
  logger.info(`output: ${outDir}`);

  const headless = process.env.QDM_HEADFUL ? false : true;
  const profileDir = process.env.QDM_PROFILE
    ? path.resolve(process.env.QDM_PROFILE)
    : existsSync(DEFAULT_PROFILE_DIR)
      ? path.resolve(DEFAULT_PROFILE_DIR)
      : undefined;

  let ctx: BrowserContext;
  let browserHandle: import("playwright").Browser | undefined;
  if (profileDir) {
    logger.info(`using persistent profile: ${profileDir}`);
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
  } else {
    browserHandle = await chromium.launch({ headless });
    ctx = await browserHandle.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
  }
  await stubBrokenRuntimeConfig(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => logger.warn(`pageerror: ${e.message}\n${e.stack ?? ""}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      logger.warn(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("requestfailed", (req) =>
    logger.warn(`requestfailed: ${req.failure()?.errorText} ${req.url()}`),
  );
  const nonOkResponses: Array<{ status: number; url: string; contentType: string }> = [];
  const navigations: string[] = [];
  const requestLog: Array<{ method: string; url: string }> = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  page.on("request", (req) => {
    const u = req.url();
    if (!/\.(png|jpg|svg|woff2?|ttf|ico|css)(\?|$)/.test(u)) {
      requestLog.push({ method: req.method(), url: u });
    }
  });
  page.on("response", (resp) => {
    const status = resp.status();
    if (status >= 400 || status === 0) {
      nonOkResponses.push({
        status,
        url: resp.url(),
        contentType: resp.headers()["content-type"] || "",
      });
    }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

    // Take an early snapshot, then wait longer for SSO/silent auth flows.
    await page.screenshot({ path: path.join(outDir, "00_initial.png"), fullPage: true });

    const totalWaitMs = parseInt(process.env.QDM_WAIT_MS || "20000", 10);
    const pollMs = 2000;
    let elapsed = 0;
    let renderedAt = 0;
    while (elapsed < totalWaitMs) {
      await page.waitForTimeout(pollMs);
      elapsed += pollMs;
      const rootChildren = await page
        .evaluate(() => document.getElementById("root")?.children.length ?? 0)
        .catch(() => 0);
      if (rootChildren > 0 && !renderedAt) {
        renderedAt = elapsed;
        logger.info(`#root populated after ~${renderedAt}ms`);
      }
    }

    await page.screenshot({ path: path.join(outDir, "01_landing.png"), fullPage: true });
    const landing = await dumpPage(page);
    await writeJson(path.join(outDir, "01_landing.json"), landing);
    logger.info(`landing: ${landing.title} — ${landing.url}`);
    const bodyHtml = (await page.locator("body").innerHTML().catch(() => "")).slice(0, 8000);
    await fs.writeFile(path.join(outDir, "01_body.html"), bodyHtml, "utf-8");

    // Dump auth artifacts so we can verify the saved session is in scope.
    const cookies = await ctx.cookies(url).catch(() => []);
    await writeJson(path.join(outDir, "cookies.json"), cookies);
    const storage = await page
      .evaluate(() => {
        const ls: Record<string, string> = {};
        const ss: Record<string, string> = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; ls[k] = (localStorage.getItem(k) ?? "").slice(0, 400); } } catch {}
        try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i)!; ss[k] = (sessionStorage.getItem(k) ?? "").slice(0, 400); } } catch {}
        return { localStorage: ls, sessionStorage: ss };
      })
      .catch(() => ({ localStorage: {}, sessionStorage: {} }));
    await writeJson(path.join(outDir, "storage.json"), storage);
    logger.info(`cookies: ${cookies.length}, localStorage keys: ${Object.keys(storage.localStorage).length}`);

    const hasPasswordField = (await page.locator('input[type="password"]').count()) > 0;

    if (hasPasswordField && user && pass) {
      logger.info("login form detected — attempting login");
      const userLoc = page
        .locator('input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i], input[type="email"], input[type="text"]')
        .first();
      const passLoc = page.locator('input[type="password"]').first();
      await userLoc.waitFor({ state: "visible", timeout: 10_000 });
      await userLoc.fill(user);
      await passLoc.fill(pass);
      await page.screenshot({ path: path.join(outDir, "02_login_filled.png"), fullPage: true });

      const submit = page
        .locator(
          'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")',
        )
        .first();
      await submit.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(3000);

      await page.screenshot({ path: path.join(outDir, "03_post_login.png"), fullPage: true });
      const postLogin = await dumpPage(page);
      await writeJson(path.join(outDir, "03_post_login.json"), postLogin);
      logger.info(`post-login: ${postLogin.title} — ${postLogin.url}`);
    } else if (hasPasswordField) {
      logger.warn("login form detected but QDM_USER/QDM_PASS not set — skipping login");
    } else {
      logger.info("no password field on landing — treating as already-authenticated or public");
    }

    if (nonOkResponses.length) {
      await writeJson(path.join(outDir, "non_ok_responses.json"), nonOkResponses);
      logger.warn(`${nonOkResponses.length} non-OK responses — see non_ok_responses.json`);
    }
    await writeJson(path.join(outDir, "navigations.json"), navigations);
    await writeJson(path.join(outDir, "requests.json"), requestLog);
    logger.info(`navigations: ${navigations.length}, requests: ${requestLog.length}`);

    logger.info(`done: ${outDir}`);
  } finally {
    await ctx.close().catch(() => undefined);
    if (browserHandle) await browserHandle.close().catch(() => undefined);
  }
}

async function dumpPage(page: Page): Promise<PageDump> {
  return page.evaluate((): PageDump => {
    const trim = (s: string | null | undefined, n = 120): string | undefined => {
      if (!s) return undefined;
      const t = String(s).replace(/\s+/g, " ").trim();
      return t ? t.slice(0, n) : undefined;
    };
    const describe = (el: Element): ElementInfo => {
      const html = el as HTMLElement & {
        name?: string;
        type?: string;
        placeholder?: string;
        value?: string;
      };
      return {
        tag: el.tagName,
        id: trim(html.id, 80),
        name: trim(html.name, 80),
        type: trim(html.type, 40),
        placeholder: trim(html.placeholder, 80),
        ariaLabel: trim(el.getAttribute("aria-label"), 80),
        dataTestId: trim(el.getAttribute("data-testid") || el.getAttribute("data-test"), 80),
        text: trim(html.innerText || html.value, 80),
        classes: trim(typeof html.className === "string" ? html.className : undefined, 160),
      };
    };
    const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
      .slice(0, 40)
      .map(describe);
    const buttons = Array.from(
      document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'),
    )
      .slice(0, 60)
      .map(describe);
    const links = Array.from(document.querySelectorAll("a"))
      .slice(0, 40)
      .map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: ((a as HTMLAnchorElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
      }));
    return { title: document.title, url: location.href, inputs, buttons, links };
  });
}

async function writeJson(filepath: string, data: unknown): Promise<void> {
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), "utf-8");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
