/**
 * Order-independent resolution of the configured translation model.
 *
 * pi-translate-x never captures a model at load time: it resolves `provider/model` lazily, per
 * request, against the live model registry. That keeps it compatible with provider extensions that
 * register (or re-register) their catalog asynchronously, such as the CLIProxyAPI providers:
 *
 * - router-for-me/pi-cliproxyapi-provider registers provider `cliproxyapi` from a cache and then
 *   re-registers it after a background `/v1/models` fetch.
 * - xiangsam/pi-cliproxyapi-provider and 0xRichardH/pi-cliproxyapi-provider register provider `cpa`
 *   (configurable) with a placeholder model until Pi's `refreshModels` pass completes.
 *
 * Resolution therefore (1) tries the exact configured model, (2) tries the same model under any
 * other registered CLIProxyAPI provider id when the configured provider is a CLIProxyAPI one, and
 * (3) on a miss asks Pi to refresh those providers once before reporting a clear error.
 */
import { TranslationError } from "./contracts.js";

export interface ResolvableModel {
  readonly provider: string;
  readonly id: string;
}

/** The subset of Pi's `ModelRegistry` this module relies on. Optional members degrade gracefully. */
export interface TranslationModelRegistry<M extends ResolvableModel = ResolvableModel> {
  find(provider: string, modelId: string): M | undefined;
  hasConfiguredAuth(model: M): boolean;
  getAll?(): M[];
  getProviderAuthStatus?(provider: string): { configured: boolean } | undefined;
  getProviderDisplayName?(provider: string): string;
  refresh?(options?: { allowNetwork?: boolean; providers?: readonly string[]; force?: boolean; signal?: AbortSignal }): Promise<unknown>;
}

export interface ResolvedTranslationModel<M extends ResolvableModel = ResolvableModel> {
  readonly model: M;
  /** `provider/id` actually used; differs from the configured ref when a fallback matched. */
  readonly resolvedRef: string;
  readonly fallback: boolean;
}

/** Provider ids used by the known CLIProxyAPI provider packages, in preference order. */
export const CLIPROXYAPI_PROVIDER_IDS: readonly string[] = Object.freeze(["cliproxyapi", "cpa"]);
const CLIPROXY_PATTERN = /cli-?proxy/i;

function envProviderIds(): string[] {
  const env = typeof process !== "undefined" ? process.env : {};
  return [env.CLIPROXYAPI_PROVIDER_ID, env.CLIPROXYAPI_PROVIDER_NAME]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

function registeredProviders(registry: TranslationModelRegistry): string[] {
  const all = safe(() => registry.getAll?.()) ?? [];
  return [...new Set(all.map((model) => model.provider))];
}

/** True when `provider` belongs to a CLIProxyAPI provider package or a models.json CLIProxyAPI entry. */
export function isCliproxyProvider(registry: TranslationModelRegistry, provider: string): boolean {
  const lower = provider.toLowerCase();
  if (CLIPROXYAPI_PROVIDER_IDS.includes(lower) || envProviderIds().some((id) => id.toLowerCase() === lower)) return true;
  if (CLIPROXY_PATTERN.test(provider)) return true;
  const display = safe(() => registry.getProviderDisplayName?.(provider));
  return typeof display === "string" && CLIPROXY_PATTERN.test(display);
}

/** Providers to try for a configured provider, the configured one always first. */
export function candidateProviders(registry: TranslationModelRegistry, provider: string): string[] {
  if (!isCliproxyProvider(registry, provider)) return [provider];
  const preferred = [...envProviderIds(), ...CLIPROXYAPI_PROVIDER_IDS];
  const registered = registeredProviders(registry).filter((id) => isCliproxyProvider(registry, id));
  const ordered = [provider, ...preferred.filter((id) => registered.includes(id)), ...registered];
  return [...new Set(ordered)];
}

const tail = (id: string) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();

function findInProvider<M extends ResolvableModel>(registry: TranslationModelRegistry<M>, provider: string, modelId: string): M | undefined {
  const exact = safe(() => registry.find(provider, modelId));
  if (exact) return exact;
  const models = (safe(() => registry.getAll?.()) ?? []).filter((model) => model.provider === provider);
  const lower = modelId.toLowerCase();
  return models.find((model) => model.id.toLowerCase() === lower)
    ?? models.find((model) => tail(model.id) === tail(modelId));
}

/** Auth check tolerant of the lagging `hasConfiguredAuth` snapshot right after a provider (re)registers. */
export function hasTranslationModelAuth<M extends ResolvableModel>(registry: TranslationModelRegistry<M>, model: M): boolean { return authConfigured(registry, model); }

function authConfigured<M extends ResolvableModel>(registry: TranslationModelRegistry<M>, model: M): boolean {
  if (safe(() => registry.hasConfiguredAuth(model))) return true;
  return safe(() => registry.getProviderAuthStatus?.(model.provider)?.configured) === true;
}

type Lookup<M extends ResolvableModel> =
  | { readonly kind: "ok"; readonly value: ResolvedTranslationModel<M> }
  | { readonly kind: "auth"; readonly model: M }
  | { readonly kind: "missing"; readonly checked: readonly string[] };

function lookup<M extends ResolvableModel>(registry: TranslationModelRegistry<M>, provider: string, modelId: string): Lookup<M> {
  const checked = candidateProviders(registry, provider);
  let unauthenticated: M | undefined;
  for (const candidate of checked) {
    const model = findInProvider(registry, candidate, modelId);
    if (!model) continue;
    if (authConfigured(registry, model)) {
      const resolvedRef = `${model.provider}/${model.id}`;
      return { kind: "ok", value: { model, resolvedRef, fallback: resolvedRef !== `${provider}/${modelId}` } };
    }
    unauthenticated ??= model;
  }
  return unauthenticated ? { kind: "auth", model: unauthenticated } : { kind: "missing", checked };
}

/** Synchronous best-effort resolution (no refresh); used for status reporting. */
export function resolveTranslationModelSync<M extends ResolvableModel>(registry: TranslationModelRegistry<M>, provider: string, modelId: string): ResolvedTranslationModel<M> | undefined {
  const result = lookup(registry, provider, modelId);
  return result.kind === "ok" ? result.value : undefined;
}

const REFRESH_COOLDOWN_MS = 30_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const refreshes = new WeakMap<object, Map<string, { promise: Promise<void>; at: number }>>();

/** One shared, bounded refresh per registry + provider set, with a cooldown after each attempt. */
function refreshProviders(registry: TranslationModelRegistry, providers: readonly string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  if (!registry.refresh) return Promise.resolve();
  let byKey = refreshes.get(registry);
  if (!byKey) { byKey = new Map(); refreshes.set(registry, byKey); }
  const key = [...providers].sort().join("\n");
  const previous = byKey.get(key);
  if (previous && Date.now() - previous.at < REFRESH_COOLDOWN_MS) return previous.promise;
  const timeout = AbortSignal.timeout(timeoutMs);
  const promise = Promise.resolve()
    .then(() => registry.refresh!({ allowNetwork: true, providers, signal: timeout }))
    .then(() => undefined, () => undefined);
  byKey.set(key, { promise, at: Date.now() });
  if (!signal) return promise;
  // The shared refresh keeps running for other callers; this caller only stops waiting.
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new TranslationError("aborted", "Request aborted")); return; }
    const onAbort = () => reject(new TranslationError("aborted", "Request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => { signal.removeEventListener("abort", onAbort); resolve(); });
  });
}

export interface ResolveOptions {
  readonly signal?: AbortSignal;
  /** Upper bound for the one-time catalog refresh on a miss. */
  readonly refreshTimeoutMs?: number;
}

/**
 * Resolve the configured translation model, refreshing the relevant provider catalogs once on a
 * miss. Throws `TranslationError("unavailable")` with an actionable message when nothing matches.
 */
export async function resolveTranslationModel<M extends ResolvableModel>(registry: TranslationModelRegistry<M>, provider: string, modelId: string, options: ResolveOptions = {}): Promise<ResolvedTranslationModel<M>> {
  let result = lookup(registry, provider, modelId);
  if (result.kind === "ok") return result.value;
  await refreshProviders(registry, candidateProviders(registry, provider), options.signal, options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
  result = lookup(registry, provider, modelId);
  if (result.kind === "ok") return result.value;
  const ref = `${provider}/${modelId}`;
  if (result.kind === "auth") {
    throw new TranslationError("unavailable", `Translation model ${result.model.provider}/${result.model.id} has no configured authentication (configured as ${ref}). Log in to that provider or run /translate-x setup.`);
  }
  const checked = result.checked.length > 1 ? ` (checked providers: ${result.checked.join(", ")})` : "";
  throw new TranslationError("unavailable", `Translation model ${ref} not found${checked}. The provider may still be loading its models; run /translate-x setup to pick an available model.`);
}
