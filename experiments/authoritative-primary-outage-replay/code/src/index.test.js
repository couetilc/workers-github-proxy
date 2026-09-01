import assert from "node:assert/strict";
import test from "node:test";

import { artifactsGitUrl, gitRoute } from "./index.js";

test("gitRoute accepts smart-HTTP repository paths", () => {
  assert.deepEqual(gitRoute("/demo.git/info/refs"), {
    name: "demo",
    suffix: "/info/refs",
  });
  assert.deepEqual(gitRoute("/demo.git/git-receive-pack"), {
    name: "demo",
    suffix: "/git-receive-pack",
  });
});

test("gitRoute rejects nested and malformed repository names", () => {
  assert.equal(gitRoute("/owner/demo.git/info/refs"), null);
  assert.equal(gitRoute("/-bad!.git/info/refs"), null);
});

test("artifactsGitUrl preserves the smart-HTTP suffix and query", () => {
  const route = gitRoute("/demo.git/info/refs");
  assert.equal(
    artifactsGitUrl(
      "0123456789abcdef0123456789abcdef",
      "experiment",
      route,
      "?service=git-receive-pack",
    ).href,
    "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/experiment/demo.git/info/refs?service=git-receive-pack",
  );
});

test("artifactsGitUrl rejects an untrusted account hostname", () => {
  assert.throws(
    () => artifactsGitUrl("example.com", "experiment", gitRoute("/demo.git")),
    /invalid Artifacts account ID/,
  );
});
