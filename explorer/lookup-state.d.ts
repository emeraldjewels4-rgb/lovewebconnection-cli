export interface LookupParams {
  chain: string | null;
  type: string | null;
  query: string | null;
}

export interface LookupStart {
  seq: number;
  signal: AbortSignal;
}

export interface LookupTracker {
  begin(): LookupStart;
  cancel(): void;
  isCurrent(candidate: number): boolean;
}

export function readLookupParams(search: string): LookupParams;
export function lookupUrl(href: string, chain: string, kind: string, query: string): string;
export function createLookupTracker(): LookupTracker;
