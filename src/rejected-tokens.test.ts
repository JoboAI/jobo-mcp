import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RejectedTokens, tokenHash } from "./rejected-tokens.js";

describe("RejectedTokens", () => {
  it("remembers a refused token until its time is up, then forgets it", () => {
    let now = 1_000;
    const store = new RejectedTokens(60_000, 10, () => now);

    store.remember("token-a");
    assert.equal(store.has("token-a"), true);
    assert.equal(store.has("token-b"), false);

    now += 59_999;
    assert.equal(store.has("token-a"), true);
    now += 1;
    assert.equal(store.has("token-a"), false);
    assert.equal(store.size, 0, "an expired entry is dropped when it is looked at");
  });

  it("keeps only a hash of each token, never the token", () => {
    const store = new RejectedTokens();
    const token = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.c2ln";

    store.remember(token);

    assert.deepEqual(store.storedKeys(), [tokenHash(token)]);
    assert.match(store.storedKeys()[0]!, /^[0-9a-f]{64}$/);
    assert.ok(!store.storedKeys()[0]!.includes(token));
  });

  it("holds at most its bound, forgetting the oldest first", () => {
    const store = new RejectedTokens(60_000, 3);
    for (const token of ["t1", "t2", "t3"]) store.remember(token);

    store.remember("t1"); // refused again: now the youngest
    store.remember("t4");

    assert.equal(store.size, 3);
    assert.equal(store.has("t2"), false, "the oldest entry is the one dropped");
    for (const token of ["t1", "t3", "t4"]) assert.equal(store.has(token), true, token);
  });
});
