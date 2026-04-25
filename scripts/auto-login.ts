/**
 * Probe the "Continue with Microsoft" login flow on a Quest Data Modeler
 * instance and (if it turns out to be a stub IdP rather than a real Azure
 * AD redirect) fill credentials and complete the login programmatically.
 *
 * Captures a screenshot + DOM dump at every step so we can see exactly
 * where the flow ends up. Uses .qdm-profile/ if present so any session
 * established here gets persisted for later `npm run demo` runs.
 *
 * Env:
 *   QDM_URL         (default http://questpmdmc.myerwin.com/auth/login)
 *   QDM_USER, QDM_PASS  filled into username/password fields if found
 *   QDM_PROFILE     override profile dir (default .qdm-profile)
 *   QDM_HEADFUL=1   show browser
 */
import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { stubBrokenRuntimeConfig } from "../utils/routes";

const DEFAULT_URL = "http://questpmdmc.myerwin.com/overview";
const DEFAULT_PROFILE = ".qdm-profile";

interface Snapshot {
  step: number;
  label: string;
  url: string;
  title: string;
  buttons: Array<{ text?: string; ariaLabel?: string; type?: string; id?: string }>;
  inputs: Array<{ type?: string; name?: string; id?: string; placeholder?: string; ariaLabel?: string }>;
}

async function main(): Promise<void> {
  const url = process.env.QDM_URL || DEFAULT_URL;
  const user = process.env.QDM_USER;
  const pass = process.env.QDM_PASS;
  const headful = !!process.env.QDM_HEADFUL;

  const profileDir = path.resolve(process.env.QDM_PROFILE || DEFAULT_PROFILE);
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("output", `autologin_${stamp}`);
  await fs.mkdir(outDir, { recursive: true });
  logger.info(`output: ${outDir}`);

  const ctx: BrowserContext = await chromium.launchPersistentContext(profileDir, {
    headless: !headful,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await stubBrokenRuntimeConfig(ctx);

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => logger.warn(`pageerror: ${e.message}`));
  const navigations: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations.push(f.url());
  });

  const snapshots: Snapshot[] = [];
  let stepNum = 0;
  const snap = async (label: string): Promise<Snapshot> => {
    stepNum += 1;
    const file = path.join(outDir, `${String(stepNum).padStart(2, "0")}_${slug(label)}`);
    await page.screenshot({ path: `${file}.png`, fullPage: true });
    const data = await page.evaluate((): Omit<Snapshot, "step" | "label"> => {
      const trim = (s: string | null | undefined, n = 80): string | undefined => {
        if (!s) return undefined;
        const t = String(s).replace(/\s+/g, " ").trim();
        return t ? t.slice(0, n) : undefined;
      };
      const collect = <T extends Element>(sel: string, fn: (el: T) => unknown): unknown[] =>
        Array.from(document.querySelectorAll<T>(sel)).slice(0, 30).map(fn);
      const buttons = collect<HTMLButtonElement>('button, [role="button"], input[type="submit"]', (el) => {
        const html = el as HTMLButtonElement;
        return {
          text: trim(html.innerText || html.value),
          ariaLabel: trim(el.getAttribute("aria-label")),
          type: trim(el.getAttribute("type")),
          id: trim(el.id),
        };
      });
      const inputs = collect<HTMLInputElement>("input, textarea, select", (el) => {
        const html = el as HTMLInputElement;
        return {
          type: trim(html.type),
          name: trim(html.name),
          id: trim(html.id),
          placeholder: trim(html.placeholder),
          ariaLabel: trim(el.getAttribute("aria-label")),
        };
      });
      return { url: location.href, title: document.title, buttons: buttons as Snapshot["buttons"], inputs: inputs as Snapshot["inputs"] };
    });
    const snapshot: Snapshot = { step: stepNum, label, ...data };
    snapshots.push(snapshot);
    logger.info(`[${stepNum}] ${label} — ${data.url}`);
    return snapshot;
  };

  try {
    logger.info(`navigating: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await waitForRoot(page);
    // Give the React app time to either render the login page or complete
    // a silent SSO refresh.
    await page.waitForTimeout(8000);
    const initial = await snap("login_page");

    // If we're already authenticated, the login button won't be there.
    const msButton = page.getByRole("button", { name: /continue with microsoft/i }).first();
    const hasMs = (await msButton.count()) > 0;
    if (!hasMs) {
      await snap("already_authenticated_or_no_login_button");
      logger.info("no Microsoft login button — session may already be active");
    } else {
      logger.info('clicking "Continue with Microsoft"');
      await msButton.click({ timeout: 10_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
      await waitForRoot(page);
      await page.waitForTimeout(2500);
      await snap("after_ms_click");

      // If a real Microsoft redirect happened we're now at login.microsoftonline.com.
      // We bail out gracefully in that case — we won't try to drive that.
      if (/login\.microsoftonline|login\.live|microsoft\.com/i.test(page.url())) {
        logger.warn("redirected to a real Microsoft login domain — cannot auto-fill safely");
      } else if (user && pass) {
        await tryFillCredentials(page, user, pass);
        await page.waitForTimeout(2500);
        await snap("after_credentials_submit");

        // After the IdP redirects with ?code=... the SPA needs time to (a)
        // bootstrap on the new origin, (b) exchange the code for tokens,
        // (c) navigate to the home/overview view. Poll every 3s for up to
        // 60s and snapshot each time the URL changes meaningfully.
        let lastUrl = page.url();
        const deadline = Date.now() + 60_000;
        let landed = false;
        while (Date.now() < deadline) {
          await page.waitForTimeout(3000);
          const u = page.url();
          if (u !== lastUrl) {
            await snap(`url_changed_${u.split("/").pop() || "root"}`);
            lastUrl = u;
          }
          if (/\/overview|\/home|\/projects|\/models|\/dashboard/.test(u) && !/auth\/callback/.test(u)) {
            await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
            await page.waitForTimeout(3000);
            await snap("landed_authenticated");
            landed = true;
            break;
          }
        }
        if (!landed) {
          await snap("timeout_did_not_land");
          logger.warn("did not reach /overview within 60s of callback");
        }
      } else {
        logger.warn("QDM_USER/QDM_PASS not set — leaving the flow at the IdP page");
      }
    }

    await fs.writeFile(path.join(outDir, "snapshots.json"), JSON.stringify(snapshots, null, 2), "utf-8");
    await fs.writeFile(path.join(outDir, "navigations.json"), JSON.stringify(navigations, null, 2), "utf-8");
    logger.info(`done — ${snapshots.length} snapshots, ${navigations.length} navigations`);
    logger.info(`final url: ${page.url()}`);
    void initial;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function waitForRoot(page: Page, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const populated = await page
      .evaluate(() => {
        const root = document.getElementById("root");
        return root ? root.children.length > 0 : true;
      })
      .catch(() => true);
    if (populated) return;
    await page.waitForTimeout(500);
  }
}

async function tryFillCredentials(page: Page, user: string, pass: string): Promise<void> {
  // Look for likely username/email field, then password field, then submit.
  const userSelectors = [
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[autocomplete="username"]',
    'input[type="text"]',
  ];
  const passSelectors = ['input[type="password"]'];
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Continue")',
  ];

  const userLoc = await firstVisible(page, userSelectors);
  const passLoc = await firstVisible(page, passSelectors);
  if (userLoc && passLoc) {
    await userLoc.fill(user);
    await passLoc.fill(pass);
    const submit = await firstVisible(page, submitSelectors);
    if (submit) {
      await submit.click();
    } else {
      await passLoc.press("Enter");
    }
    return;
  }
  if (passLoc && !userLoc) {
    // Some flows split user/pass across two screens.
    await passLoc.fill(pass);
    const submit = await firstVisible(page, submitSelectors);
    if (submit) await submit.click();
    return;
  }
  if (userLoc && !passLoc) {
    await userLoc.fill(user);
    const next = await firstVisible(page, submitSelectors);
    if (next) {
      await next.click();
      await page.waitForTimeout(2000);
      const passLoc2 = await firstVisible(page, passSelectors);
      if (passLoc2) {
        await passLoc2.fill(pass);
        const submit = await firstVisible(page, submitSelectors);
        if (submit) await submit.click();
        else await passLoc2.press("Enter");
      }
    }
  }
}

async function firstVisible(page: Page, selectors: string[]): Promise<import("playwright").Locator | undefined> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) {
      const visible = await loc.isVisible().catch(() => false);
      if (visible) return loc;
    }
  }
  return undefined;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
