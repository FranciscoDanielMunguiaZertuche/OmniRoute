import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { solveDeepSeekPowAsync } from "../../open-sse/lib/deepseek-pow.ts";

const repoRoot = new URL("../../", import.meta.url);
const redistributedWasm = new URL("../../open-sse/lib/sha3_wasm_bg.wasm", import.meta.url);

test("DeepSeek PoW remains functional without redistributing the unlicensed WASM", async () => {
  const answer = await solveDeepSeekPowAsync(
    "DeepSeekHashV1",
    "311b26ae1e0fe7375e242958ce46db5552a6c67fea3f96880dcd846c63a74286",
    "1122334455667788",
    1,
    1778891543095
  );

  assert.equal(answer, 0, "the retained JavaScript solver must satisfy the known PoW vector");
  assert.equal(
    existsSync(redistributedWasm),
    false,
    "the unlicensed DeepSeek WASM binary must not be redistributed"
  );

  for (const relativePath of [
    "open-sse/lib/deepseek-pow.ts",
    "next.config.mjs",
    "package.json",
    "open-sse/package.json",
  ]) {
    const contents = readFileSync(new URL(relativePath, repoRoot), "utf8");
    assert.doesNotMatch(
      contents,
      /sha3_wasm_bg\.wasm/,
      `${relativePath} must not reference the removed WASM artifact`
    );
  }
});
