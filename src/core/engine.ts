import { TranslationError, type TranslationRequest, type TranslationResult, type Translator } from "./contracts.js";
import { protectLiterals } from "./protection.js";
export type RawTranslate = (request: TranslationRequest, protectedSource: string) => Promise<string>;

function withDeadline<T>(factory: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { if (timer) clearTimeout(timer); parent.removeEventListener("abort", onAbort); };
    const finish = (fn: (value: any) => void, value: any) => { if (settled) return; settled = true; cleanup(); fn(value); };
    onAbort = () => { controller.abort(parent.reason ?? "Parent aborted"); finish(reject, new TranslationError("aborted", "Request aborted")); };
    parent.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { controller.abort("Translation timeout"); finish(reject, new TranslationError("timeout", `Translation exceeded ${ms}ms`)); }, ms);
    if (parent.aborted) { onAbort(); return; }
    Promise.resolve().then(() => factory(controller.signal)).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export class ProtectedTranslationEngine implements Translator {
  constructor(private readonly translateRaw: RawTranslate, private readonly maxChars = 50_000) {}
  async translate(request: TranslationRequest): Promise<TranslationResult> {
    if (request.signal.aborted) throw new TranslationError("aborted", "Request aborted");
    if (!request.source.length) throw new TranslationError("empty", "Source is empty");
    if (request.source.length > this.maxChars) throw new TranslationError("provider", `Source exceeds ${this.maxChars} characters`);
    const protectedText = protectLiterals(request.source);
    if (!protectedText.prose) return { requestId: request.requestId, text: request.source };
    const translated = await withDeadline((signal) => this.translateRaw({ ...request, signal }, protectedText.masked), request.timeoutMs ?? 60_000, request.signal);
    if (!translated || !translated.trim()) throw new TranslationError("empty", "Translator returned empty text");
    return { requestId: request.requestId, text: protectedText.restore(translated) };
  }
}
