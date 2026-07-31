import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, WORK_MODELS } from "./filters.js";

/**
 * Drift guard: this package intentionally has no dependency on
 * connector-core, so its enum arrays are a local copy. This test pins them
 * to the shared contract (generated from connector-core's filters.ts).
 * Skipped when the contract is absent — the public mirror of mcp/ and the
 * Docker build don't carry ../contracts/.
 */
describe("filter enums match the shared contract", () => {
  const contractPath = join(import.meta.dirname, "..", "..", "contracts", "filters.json");

  it("work models, employment types and experience levels", (t) => {
    if (!existsSync(contractPath)) {
      t.skip("contracts/filters.json not present (mirror or Docker build)");
      return;
    }
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
      enums: { work_models: string[]; employment_types: string[]; experience_levels: string[] };
    };
    assert.deepEqual([...WORK_MODELS], contract.enums.work_models);
    assert.deepEqual([...EMPLOYMENT_TYPES], contract.enums.employment_types);
    assert.deepEqual([...EXPERIENCE_LEVELS], contract.enums.experience_levels);
  });
});
