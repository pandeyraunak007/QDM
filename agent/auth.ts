import { Page } from "playwright";
import { logger } from "../utils/logger";

export interface EnsureAuthOptions {
  user?: string;
  pass?: string;
  /** Maximum time to wait for the post-callback redirect to settle. */
  postCallbackTimeoutMs?: number;
}

/**
 * If the page is currently sitting on the QDM login screen, drive the
 * "Continue with Microsoft" → Mart Portal credentials → OAuth callback
 * flow programmatically using QDM_USER / QDM_PASS. If we're already
 * authenticated (no Microsoft button visible), return immediately.
 *
 * Safe to call before every flow run — it's a no-op when the session is
 * still valid.
 */
export async function ensureAuthenticated(page: Page, opts: EnsureAuthOptions = {}): Promise<boolean> {
  const user = opts.user ?? process.env.QDM_USER;
  const pass = opts.pass ?? process.env.QDM_PASS;

  // Give the SPA a chance to render its login UI (it crashes once before
  // recovering on cold contexts; the recovery typically takes ~15-25s).
  await waitForRenderedRoot(page, 35_000);

  const msButton = page.getByRole("button", { name: /continue with microsoft/i }).first();
  const hasMs = await msButton.count().then((n) => n > 0).catch(() => false);

  if (!hasMs) {
    logger.debug("auth: already authenticated");
    return false;
  }

  if (!user || !pass) {
    throw new Error(
      "auth: login screen detected but QDM_USER / QDM_PASS env vars are not set",
    );
  }

  logger.info("auth: login screen detected — running Mart Portal credential flow");
  await msButton.click({ timeout: 10_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await waitForRenderedRoot(page, 30_000);

  if (/login\.microsoftonline|login\.live/i.test(page.url())) {
    throw new Error("auth: redirected to a real Microsoft login domain — cannot auto-fill safely");
  }

  // Wait for the IdP's password field to appear before attempting to fill —
  // some IdP pages take a few seconds after navigation to render the form.
  await page
    .locator('input[type="password"]')
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(800);

  await fillCredentials(page, user, pass);

  // Wait for the OAuth callback to be exchanged and for the SPA to reach a
  // post-login URL.
  const deadline = Date.now() + (opts.postCallbackTimeoutMs ?? 60_000);
  let lastUrl = page.url();
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const u = page.url();
    if (u !== lastUrl) {
      logger.debug(`auth: navigation → ${u}`);
      lastUrl = u;
    }
    if (/\/overview|\/home|\/projects|\/models|\/dashboard/i.test(u) && !/auth\/(login|callback)/i.test(u)) {
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      logger.info(`auth: signed in — ${u}`);
      return true;
    }
  }
  throw new Error(`auth: did not reach an authenticated URL within timeout (last: ${lastUrl})`);
}

async function waitForRenderedRoot(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const populated = await page
      .evaluate(() => {
        const root = document.getElementById("root");
        return root ? root.children.length > 0 : true;
      })
      .catch(() => true);
    if (populated) {
      // Small extra delay for any post-mount state updates to settle.
      await page.waitForTimeout(800);
      return;
    }
    await page.waitForTimeout(500);
  }
}

async function fillCredentials(page: Page, user: string, pass: string): Promise<void> {
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
    if (submit) await submit.click();
    else await passLoc.press("Enter");
    return;
  }
  if (userLoc) {
    await userLoc.fill(user);
    const next = await firstVisible(page, submitSelectors);
    if (next) {
      await next.click();
      await page.waitForTimeout(2000);
      const passLoc2 = await firstVisible(page, passSelectors);
      if (passLoc2) {
        await passLoc2.fill(pass);
        const submit2 = await firstVisible(page, submitSelectors);
        if (submit2) await submit2.click();
        else await passLoc2.press("Enter");
      }
    }
    return;
  }
  throw new Error("auth: could not locate username/password fields on the IdP page");
}

async function firstVisible(page: Page, selectors: string[]): Promise<import("playwright").Locator | undefined> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
      return loc;
    }
  }
  return undefined;
}
