/**
 * One-time authenticated-session bootstrap for a live Quest Data Modeler instance.
 *
 * Launches Chromium with a persistent user-data directory (./.qdm-profile by
 * default) and opens the login page. You sign in manually in the browser —
 * including whatever SSO / "Continue with Microsoft" flow the instance uses.
 * When you close the browser window, your cookies + localStorage + service
 * workers are already persisted to disk. All subsequent `npm run demo` runs
 * reuse the same profile via Playwright's launchPersistentContext and skip
 * login entirely.
 *
 * Usage:
 *   npx ts-node scripts/bootstrap.ts
 *   QDM_URL=http://your-instance/auth/login npx ts-node scripts/bootstrap.ts
 *   QDM_PROFILE=/abs/path/profile npx ts-node scripts/bootstrap.ts
 */
import { chromium } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../utils/logger";
import { stubBrokenRuntimeConfig } from "../utils/routes";

const DEFAULT_LOGIN_URL = "http://questpmdmc.myerwin.com/auth/login";
const DEFAULT_PROFILE_DIR = ".qdm-profile";

async function main(): Promise<void> {
  const url = process.env.QDM_URL || DEFAULT_LOGIN_URL;
  const profileDir = path.resolve(process.env.QDM_PROFILE || DEFAULT_PROFILE_DIR);

  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
    logger.info(`created profile: ${profileDir}`);
  } else {
    logger.info(`reusing profile: ${profileDir}`);
  }

  logger.info(`opening: ${url}`);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });

  await stubBrokenRuntimeConfig(context);

  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (err) => logger.warn(`pageerror: ${err.message}`));

  await page
    .goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch((e) => logger.warn(`initial goto: ${(e as Error).message}`));

  printInstructions();

  await new Promise<void>((resolve) => {
    context.once("close", () => resolve());
  });

  logger.info(`session saved to: ${profileDir}`);
  logger.info("next: npm run demo -- --flow=<flow-name>");
}

function printInstructions(): void {
  const lines = [
    "",
    "================================================================",
    "  MANUAL LOGIN — complete these steps in the browser window:",
    "    1. Click \"Continue with Microsoft\" (or equivalent)",
    "    2. Sign in with your QDM credentials",
    "    3. Wait for the app to load (you should see the main UI)",
    "    4. CLOSE the browser window — your session will be saved",
    "================================================================",
    "",
  ];
  for (const l of lines) logger.info(l);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
