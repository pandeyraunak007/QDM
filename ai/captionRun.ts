/**
 * Shared helpers for the deck and video orchestrators: pick a run dir,
 * load its steps.json, batch the steps through the caption generator,
 * write steps_described.json. Returns the resolved paths so callers can
 * invoke the appropriate Python builder.
 */
import * as fs from "fs/promises";
import { readdirSync, statSync, existsSync } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { generateDescriptions, StepInput, SlideContent } from "./descriptionGenerator";

export interface ManifestStep {
  index: number;
  label: string;
  action: string;
  selector?: string;
  value?: string;
  screenshot?: string;
  ok?: boolean;
  title?: string;
  description?: string;
}

export interface Manifest {
  flow_name?: string;
  base_url?: string;
  generated_at?: string;
  total_steps?: number;
  executed_steps?: number;
  ok?: boolean;
  steps: ManifestStep[];
}

export interface PreparedRun {
  runDir: string;
  manifestPath: string;
  augmentedPath: string;
  manifest: Manifest;
}

export function resolveRunDir(arg: string | undefined): string | undefined {
  if (arg && arg !== "--latest") return path.resolve(arg);
  return pickLatestRun();
}

export function pickLatestRun(): string | undefined {
  const root = path.resolve("output");
  if (!existsSync(root)) return undefined;
  const entries = readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(path.join(p, "steps.json"));
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return entries[0];
}

export async function prepareRun(runDir: string): Promise<PreparedRun> {
  const manifestPath = path.join(runDir, "steps.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`no steps.json in ${runDir}`);
  }
  logger.info(`run dir: ${runDir}`);

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Manifest;
  const augmentedPath = path.join(runDir, "steps_described.json");

  // Reuse cached captions if steps_described.json already exists and matches
  // the step count — avoids re-charging the API on every artifact build.
  if (existsSync(augmentedPath)) {
    try {
      const cached = JSON.parse(await fs.readFile(augmentedPath, "utf-8")) as Manifest;
      if (cached.steps?.length === manifest.steps.length) {
        logger.info("reusing cached captions in steps_described.json");
        return { runDir, manifestPath, augmentedPath, manifest: cached };
      }
    } catch {
      /* fall through to regenerate */
    }
  }

  const stepInputs: StepInput[] = manifest.steps.map((s) => ({
    index: s.index,
    label: s.label,
    action: s.action,
    selector: s.selector,
    value: s.value,
  }));

  logger.info(`generating captions for ${stepInputs.length} steps…`);
  const captions = await generateDescriptions(stepInputs);
  const captionByIndex = new Map<number, SlideContent>(captions.map((c) => [c.index, c]));

  const augmented: Manifest = {
    ...manifest,
    steps: manifest.steps.map((s) => {
      const caption = captionByIndex.get(s.index);
      return {
        ...s,
        title: caption?.title,
        description: caption?.description,
      };
    }),
  };

  await fs.writeFile(augmentedPath, JSON.stringify(augmented, null, 2), "utf-8");
  logger.info(`wrote: ${augmentedPath}`);

  return { runDir, manifestPath, augmentedPath, manifest: augmented };
}
