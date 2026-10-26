import { createHash, randomUUID } from "node:crypto";
import type { DurableTranslationRecord } from "./contracts.js";
import { PROTECTION_VERSION } from "./protection.js";

export type RecordInput = Omit<DurableTranslationRecord, "version" | "recordId" | "createdAt" | "protectionVersion"> & { readonly original?: string; readonly createdAt?: string };
export function createRecord(input: RecordInput): DurableTranslationRecord & { readonly original?: string } {
  const record = { ...input, version: 1 as const, protectionVersion: PROTECTION_VERSION, recordId: randomUUID(), createdAt: input.createdAt ?? new Date().toISOString() };
  return Object.freeze(record);
}

export function isDurableTranslationRecord(value: unknown): value is DurableTranslationRecord & { readonly original?: string } {
  if (value === null || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  if (x.version !== 1 || (x.kind !== "input" && x.kind !== "output") || typeof x.recordId !== "string" || typeof x.sessionId !== "string" || typeof x.branchId !== "string" || typeof x.source !== "string" || typeof x.translated !== "string" || typeof x.targetLanguage !== "string" || typeof x.modelRef !== "string" || x.protectionVersion !== PROTECTION_VERSION || typeof x.createdAt !== "string") return false;
  if (x.kind === "input") return typeof x.submissionId === "string" && x.inputDisposition === "prepared-for-input-pipeline" && x.messageEntryId === undefined && x.original === x.source;
  return typeof x.messageEntryId === "string" && x.submissionId === undefined && x.inputDisposition === undefined && x.original === undefined;
}

export function cacheKey(parts: { source: string; sourceLanguage?: string; targetLanguage: string; modelRef: string; protectionVersion: number }): string {
  return createHash("sha256").update(JSON.stringify([parts.source, parts.sourceLanguage ?? null, parts.targetLanguage, parts.modelRef, parts.protectionVersion])).digest("hex");
}
export class TranslationCache {
  readonly #values = new Map<string, string>();
  get(parts: Parameters<typeof cacheKey>[0]): string | undefined { return this.#values.get(cacheKey(parts)); }
  set(parts: Parameters<typeof cacheKey>[0], value: string): void { this.#values.set(cacheKey(parts), value); }
  clear(): void { this.#values.clear(); }
  get size(): number { return this.#values.size; }
}
