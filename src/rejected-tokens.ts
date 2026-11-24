/**
 * Access tokens the Jobo API has refused, remembered for a few minutes.
 *
 * The gateway only reads a token's `exp`; it does not check the signature or
 * ask whether the token was revoked. When the API refuses a token for another
 * reason (revoked, signing key rotated), the tool call that found out returns
 * a tool error inside an HTTP 200, and an MCP client only starts sign-in again
 * from a real HTTP 401. Without this the client stays "connected" while every
 * call fails. With it, the next request carrying that token gets the same 401
 * challenge an expired token gets, and the client signs in again.
 *
 * Only a SHA-256 hash of each token is kept, never the token itself, and only
 * in this process: a second replica learns about the token on its own first
 * failed call. Bounded in size, so a flood of bad tokens cannot grow it.
 */

import { createHash } from "node:crypto";

/** How long a refused token is answered with a 401 without asking the API again. */
export const REJECTED_TOKEN_TTL_MS = 5 * 60 * 1000;
/** The most tokens remembered at once; the oldest is forgotten first. */
export const REJECTED_TOKEN_MAX_ENTRIES = 10_000;

/** What is stored for a token: its SHA-256, hex. Never the token. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RejectedTokens {
  /** Hash → when to forget it. A Map keeps insertion order, so the first key is the oldest. */
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = REJECTED_TOKEN_TTL_MS,
    private readonly maxEntries: number = REJECTED_TOKEN_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  remember(token: string): void {
    const hash = tokenHash(token);
    // Delete first, so a token refused again moves to the young end.
    this.entries.delete(hash);
    this.entries.set(hash, this.now() + this.ttlMs);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  has(token: string): boolean {
    const hash = tokenHash(token);
    const expires = this.entries.get(hash);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.entries.delete(hash);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The stored keys, for tests that check no raw token is held. */
  storedKeys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The one store the gateway and the upstream client share. */
export const rejectedTokens = new RejectedTokens();
