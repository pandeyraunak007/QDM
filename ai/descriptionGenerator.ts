import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger";

export interface StepInput {
  index: number;
  label: string;
  action: string;
  selector?: string;
  value?: string;
}

export interface SlideContent {
  index: number;
  title: string;
  description: string;
}

const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You write slide content for a Quest Data Modeler product demo.

Audience: business analysts and engineers learning data modeling — they understand databases at a high level but may not be familiar with this specific tool.

For each numbered step, produce:
  - title: 4–8 words, imperative or present tense, no trailing punctuation, no quotes (e.g. "Open the New Model dialog")
  - description: 1–2 short sentences (≤ 200 chars total) that explain what is happening on screen and *why* it matters in a real modeling workflow. Plain English, no jargon when possible.

Never start the title with a number. Never repeat the index in the title or description. Never use markdown.`;

export async function generateDescriptions(steps: StepInput[]): Promise<SlideContent[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn("ANTHROPIC_API_KEY not set — using label-based captions");
    return steps.map(fallback);
  }

  const stepsBlock = steps.map((s) => `${s.index}. ${s.label}`).join("\n");
  const userMessage = `Steps from a single demo run:\n\n${stepsBlock}\n\nReturn EXACTLY a JSON array, one object per step, in the same order:\n[{"index": <int>, "title": "...", "description": "..."}, ...]\nNo prose, no code fences, no surrounding text.`;

  const client = new Anthropic({ apiKey });

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: "[" },
      ],
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const reconstructed = `[${text}`;
    const arr = parseJsonArrayPrefix(reconstructed);
    return reconcile(steps, arr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Claude caption call failed (${msg}); falling back to label-based captions`);
    return steps.map(fallback);
  }
}

function fallback(s: StepInput): SlideContent {
  const action = friendlyAction(s.action);
  return {
    index: s.index,
    title: titleCase(s.label).slice(0, 70),
    description: `${action} ${s.label.charAt(0).toLowerCase() + s.label.slice(1)}.`,
  };
}

function friendlyAction(a: string): string {
  switch (a) {
    case "click": return "We click to";
    case "clickAt": return "We position the cursor and click to";
    case "type": return "We type into the field to";
    case "press": return "We press a key to";
    case "drag": return "We drag to";
    case "wait": return "The app prepares —";
    case "waitForCanvas": return "We wait for the canvas to render after";
    case "goto": return "We navigate to";
    case "screenshot": return "We capture a screenshot to";
    default: return "We";
  }
}

function titleCase(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function parseJsonArrayPrefix(s: string): unknown {
  // Find the longest balanced JSON array prefix; the model's response after
  // the prefilled "[" is usually clean but occasionally has trailing prose.
  const start = s.indexOf("[");
  if (start < 0) throw new Error("response missing '['");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error("response did not close JSON array");
}

function reconcile(input: StepInput[], parsed: unknown): SlideContent[] {
  if (!Array.isArray(parsed)) throw new Error("LLM did not return an array");
  const byIndex = new Map<number, SlideContent>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const idx = typeof r.index === "number" ? r.index : Number(r.index);
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const description = typeof r.description === "string" ? r.description.trim() : "";
    if (!Number.isFinite(idx)) continue;
    if (!title || !description) continue;
    byIndex.set(idx, { index: idx, title, description });
  }
  return input.map((s) => byIndex.get(s.index) ?? fallback(s));
}
