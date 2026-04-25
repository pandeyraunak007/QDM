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

const SYSTEM_PROMPT = `You write slide content AND voice narration for a Quest Data Modeler product demo.

Audience: business analysts and engineers learning data modeling. They understand databases at a high level but may be new to this tool.

The description text is *both* shown on a slide *and* read aloud by a text-to-speech engine, so it must sound natural when spoken. Use complete sentences, a friendly tour-guide voice, and avoid:
  - em-dashes (—) and slashes used as punctuation (TTS pronounces them awkwardly)
  - parenthetical asides
  - abbreviations the engine might mispronounce ("e.g.", "i.e.", "ER")
  - sentence fragments
  - the word "step" or "step number"

For each numbered input step, produce:
  - title: 4–8 words, imperative present tense, no trailing punctuation, no quotes (e.g. "Open the New Model dialog")
  - description: 1 or 2 complete sentences, 200 characters max total. Start with what is happening, then briefly say why it matters in a real modeling workflow. Spell out acronyms on first use.

Examples of GOOD descriptions (spoken-aloud quality):
  "Click New Model to start a fresh data model from scratch."
  "The Overview page shows recent and favorite models so you can resume work quickly."
  "We name the entity Customer. Clear entity names make the diagram self-documenting."

Examples to AVOID:
  "We click to open the New Model dialog." (too literal, no context)
  "The app prepares — wait for the Overview page." (em-dash, terse)
  "Type into field — Customer DB." (fragment, em-dash)

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
  // Keep the fallback narration-friendly: just clean the label and use it as
  // a complete sentence. No machine-templated prefixes (e.g. "We click to ...")
  // because they read as obviously-templated when spoken aloud.
  const cleaned = s.label.replace(/\s+/g, " ").trim();
  const sentence = /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
  return {
    index: s.index,
    title: cleaned.slice(0, 70),
    description: sentence,
  };
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
