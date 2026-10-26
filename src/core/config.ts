import type { DisplayMode, TranslationSettings } from "./contracts.js";

export interface ConfigInput {
  enabled?: unknown;
  input?: unknown;
  output?: unknown;
  targetLanguage?: unknown;
  provider?: unknown;
  model?: unknown;
  displayMode?: unknown;
  timeoutMs?: unknown;
}

export const CONFIG_VERSION = 1;
export interface PackageConfig extends TranslationSettings {
  readonly version: typeof CONFIG_VERSION;
}

const MODES = new Set<DisplayMode>(["bilingual", "original"]);
const KNOWN = new Set(["version", "enabled", "input", "output", "targetLanguage", "provider", "model", "displayMode", "timeoutMs"]);

export function validateConfig(input: unknown): PackageConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Configuration must be a JSON object");
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !KNOWN.has(key));
  if (unknown.length) throw new Error(`Unknown configuration field(s): ${unknown.join(", ")}`);
  if (raw.version !== CONFIG_VERSION) throw new Error(`Unsupported or missing config version (expected ${CONFIG_VERSION})`);
  for (const key of ["enabled", "input", "output"] as const) {
    if (typeof raw[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  }
  for (const key of ["targetLanguage", "provider", "model"] as const) {
    if (typeof raw[key] !== "string" || raw[key].length === 0 || raw[key] !== raw[key].trim()) throw new Error(`${key} must be a non-empty, trimmed string`);
  }
  if (typeof raw.displayMode !== "string" || !MODES.has(raw.displayMode as DisplayMode)) throw new Error("displayMode must be bilingual or original");
  if (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 1_000 || (raw.timeoutMs as number) > 300_000) throw new Error("timeoutMs must be an integer between 1000 and 300000");
  return Object.freeze({
    version: CONFIG_VERSION,
    enabled: raw.enabled as boolean,
    input: raw.input as boolean,
    output: raw.output as boolean,
    targetLanguage: raw.targetLanguage as string,
    provider: raw.provider as string,
    model: raw.model as string,
    displayMode: raw.displayMode as DisplayMode,
    timeoutMs: raw.timeoutMs as number,
  });
}

export const emptyConfigState = (): { configured: false; error?: string } => ({ configured: false });
