import assert from "node:assert/strict";
import test from "node:test";

import { classifyReplay } from "./replay-policy.js";

const BEFORE = "1".repeat(40);
const DESIRED = "2".repeat(40);
const UNRELATED = "3".repeat(40);

test("desired at GitHub is synced", () => {
  assert.equal(
    classifyReplay({ before: BEFORE, desired: DESIRED, observed: DESIRED }),
    "synced",
  );
});

test("recorded before at GitHub remains pending", () => {
  assert.equal(
    classifyReplay({ before: BEFORE, desired: DESIRED, observed: BEFORE }),
    "pending_sync",
  );
});

test("an unrelated GitHub OID needs review", () => {
  assert.equal(
    classifyReplay({ before: BEFORE, desired: DESIRED, observed: UNRELATED }),
    "needs_review",
  );
});

test("an unavailable GitHub requires later verification", () => {
  assert.equal(
    classifyReplay({
      before: BEFORE,
      desired: DESIRED,
      observed: null,
      available: false,
    }),
    "verification_required",
  );
});
