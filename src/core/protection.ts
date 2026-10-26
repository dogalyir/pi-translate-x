import { randomBytes } from "node:crypto";
import { TranslationError } from "./contracts.js";

export const PROTECTION_VERSION = 2 as const;
export interface ProtectedText { readonly masked: string; readonly restore: (translated: string) => string; readonly tokens: readonly string[]; readonly prose: boolean; }

function scanLiterals(source: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const chars = Array.from(source);
  for (let i = 0; i < source.length;) {
    const lineStart = i === 0 || source[i - 1] === "\n";
    if (lineStart) {
      const match = /^( {0,3})(`{3,}|~{3,})/.exec(source.slice(i));
      if (match) {
        const indent = match[1]!.length, marker = match[2]!, char = marker[0]!, minimum = marker.length;
        const openingEnd = source.indexOf("\n", i);
        if (openingEnd < 0) { spans.push({ start: i, end: source.length }); break; }
        const closePattern = new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${minimum},}\\s*$`);
        let cursor = openingEnd + 1, end = source.length;
        while (cursor < source.length) {
          const next = source.indexOf("\n", cursor); const lineEnd = next < 0 ? source.length : next;
          if (closePattern.test(source.slice(cursor, lineEnd).replace(/\r$/, ""))) { end = next < 0 ? lineEnd : next + 1; break; }
          cursor = next < 0 ? source.length : next + 1;
        }
        spans.push({ start: i, end }); i = end; continue;
      }
    }
    if (source[i] === "`") {
      let n = 1; while (source[i + n] === "`") n++;
      const close = source.indexOf("`".repeat(n), i + n);
      if (close >= 0) { spans.push({ start: i, end: close + n }); i = close + n; continue; }
    }
    if (source.startsWith("http://", i) || source.startsWith("https://", i)) {
      let end = i; while (end < source.length && !/[\s)>\]]/.test(source[end]!)) end++;
      spans.push({ start: i, end }); i = end; continue;
    }
    if (source.startsWith("⟪PI_LITERAL_", i)) { const close = source.indexOf("⟫", i); if (close >= 0) { spans.push({ start: i, end: close + 1 }); i = close + 1; continue; } }
    if ((i === 0 || /\s/.test(source[i - 1]!)) && /^(?:\.\.?\/|~\/|\/|[A-Za-z]:\\)/.test(source.slice(i))) {
      let end = i; while (end < source.length && !/\s/.test(source[end]!)) end++;
      spans.push({ start: i, end }); i = end; continue;
    }
    i++;
  }
  return spans;
}

export function protectLiterals(source: string): ProtectedText {
  const spans = scanLiterals(source);
  const nonce = randomBytes(12).toString("hex");
  const tokens: string[] = []; let masked = ""; let cursor = 0;
  for (const span of spans) {
    masked += source.slice(cursor, span.start);
    const token = `⟪PI_LITERAL_${nonce}_${tokens.length}⟫`;
    tokens.push(token); masked += token; cursor = span.end;
  }
  masked += source.slice(cursor);
  const literals = spans.map((s) => source.slice(s.start, s.end));
  const unprotected = masked.replace(new RegExp(`⟪PI_LITERAL_${nonce}_\\d+⟫`, "g"), " ");
  const prose = /\p{L}/u.test(unprotected);
  return { masked, tokens, prose, restore(translated) {
    let output = translated;
    const found = output.match(new RegExp(`⟪PI_LITERAL_${nonce}_\\d+⟫`, "g")) ?? [];
    for (const token of tokens) if (found.filter((x) => x === token).length !== 1) throw new TranslationError("integrity", `Protected placeholder count invalid for ${token}`);
    if (found.some((token) => !tokens.includes(token))) throw new TranslationError("integrity", "Unknown protected placeholder");
    for (let index = 0; index < tokens.length; index++) output = output.replace(tokens[index]!, () => literals[index]!);
    return output;
  } };
}
