type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveMinLevel(): Level {
  const raw = (process.env.LOG_LEVEL || "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

const minLevel: Level = resolveMinLevel();

function emit(level: Level, msg: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string): void => emit("debug", m),
  info: (m: string): void => emit("info", m),
  warn: (m: string): void => emit("warn", m),
  error: (m: string): void => emit("error", m),
};
