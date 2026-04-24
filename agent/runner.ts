#!/usr/bin/env node
import { chromium, Browser, BrowserContext } from "playwright";
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import { loadFlow, executeFlow } from "./flowExecutor";
import { logger } from "../utils/logger";
import { stubBrokenRuntimeConfig } from "../utils/routes";

const DEFAULT_PROFILE_DIR = ".qdm-profile";

interface CliOptions {
  flow?: string;
  url?: string;
  output: string;
  flowsDir: string;
  headless: boolean;
  viewport: string;
  slowMo: string;
  profile?: string;
  noProfile: boolean;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("quest-demo-agent")
    .description("Phase 1: Playwright flow runner + screenshot capture for Quest Data Modeler")
    .option("-f, --flow <name>", "flow file name (e.g. createModel) or path to .json")
    .option("-u, --url <url>", "override base_url defined in the flow")
    .option("-o, --output <dir>", "root output directory", "output")
    .option("--flows-dir <dir>", "flows directory", "flows")
    .option("--headless", "run browser headless (default: headful for demos)", false)
    .option("--viewport <WxH>", "viewport size", "1440x900")
    .option("--slow-mo <ms>", "slow-motion delay between actions (ms)", "150")
    .option("--profile <dir>", "persistent Chromium profile (for authenticated sessions)")
    .option("--no-profile", "ignore any auto-detected .qdm-profile and run fresh", false)
    .parse(process.argv);

  const opts = program.opts<CliOptions>();

  if (!opts.flow) {
    logger.error("Missing --flow. Example: npm run demo -- --flow=createModel");
    process.exit(1);
  }

  const viewport = parseViewport(opts.viewport);
  const slowMo = parseInt(opts.slowMo, 10) || 0;
  const flowPath = await resolveFlowPath(opts.flow, opts.flowsDir);
  logger.info(`loading flow: ${flowPath}`);

  const flow = await loadFlow(flowPath);
  if (opts.url) {
    const normalized = normalizeUrl(opts.url);
    logger.info(`overriding base_url → ${normalized}`);
    flow.base_url = normalized;
  } else if (flow.base_url) {
    flow.base_url = normalizeUrl(flow.base_url);
  }

  const profileDir = resolveProfileDir(opts);

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let exitCode = 0;

  try {
    if (profileDir) {
      logger.info(`using persistent profile: ${profileDir}`);
      context = await chromium.launchPersistentContext(profileDir, {
        headless: opts.headless,
        slowMo,
        viewport,
        ignoreHTTPSErrors: true,
      });
    } else {
      browser = await chromium.launch({ headless: opts.headless, slowMo });
      context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    }

    await stubBrokenRuntimeConfig(context);

    const page = context.pages()[0] ?? (await context.newPage());
    page.on("pageerror", (err) => logger.warn(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") logger.debug(`console.error: ${msg.text()}`);
    });

    const result = await executeFlow(page, flow, path.resolve(opts.output));
    logger.info(`manifest: ${result.manifestPath}`);
    logger.info(`screenshots: ${result.screenshotsDir}`);
    exitCode = result.ok ? 0 : 1;
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error(msg);
    exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }

  process.exit(exitCode);
}

function resolveProfileDir(opts: CliOptions): string | undefined {
  if (opts.noProfile) return undefined;
  if (opts.profile) return path.resolve(opts.profile);
  if (existsSync(DEFAULT_PROFILE_DIR)) return path.resolve(DEFAULT_PROFILE_DIR);
  return undefined;
}

function normalizeUrl(urlOrPath: string): string {
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(urlOrPath) || urlOrPath.startsWith("file:")) {
    return urlOrPath;
  }
  return "file://" + path.resolve(urlOrPath);
}

function parseViewport(raw: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (!match) throw new Error(`Invalid --viewport: ${raw} (expected WIDTHxHEIGHT, e.g. 1440x900)`);
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

async function resolveFlowPath(flowArg: string, flowsDir: string): Promise<string> {
  const candidates = [
    flowArg,
    `${flowArg}.json`,
    path.join(flowsDir, flowArg),
    path.join(flowsDir, `${flowArg}.json`),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return path.resolve(c);
    } catch {
      /* try next */
    }
  }
  throw new Error(`Flow not found. Tried: ${candidates.join(", ")}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(msg);
  process.exit(1);
});
