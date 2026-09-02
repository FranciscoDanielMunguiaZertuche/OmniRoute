#!/usr/bin/env node
/**
 * postbuild patch: TokenRouter GLM reasoning_effort=max passthrough
 *
 * `open-sse/executors/base/reasoningEffort.ts` (supportsMaxEffortForProvider)
 * is patched in SOURCE so a clean build carries it — this script is the
 * belt-and-braces safety net: if the deployed dist was built from a checkout
 * that predates the source fix (or from a dirty patch context), the compiled
 * Next.js chunks would otherwise normalize literal `max` → `xhigh` and
 * silently drop TokenRouter GLM's top reasoning tier.
 *
 * Idempotent: the needle is the exact minified agentrouter-GLM boolean-chain
 * fragment. We only append the tokenrouter clause when it is absent; nothing
 * is re-added when already patched or when the source fix is already compiled
 * in. Regex captures the minified identifier names so it survives rebuilds
 * that rename local variables (b, z) from build to build.
 *
 * Usage: node scripts/ops/postbuild-tokenrouter-max-patch.mjs
 * Exits 0 always — never breaks a build. Prints what it did.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

// Resolve the .next output from build config (independent of human judgment:
// mirrors the isolation used by scripts/build/build-next-isolated.mjs).
const DIST_NEXT_CANDIDATES = [
  join(ROOT, "dist/.build/next/server"),
  join(ROOT, "dist/.next/server"),
  join(ROOT, ".next/server"),
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && /\.js$/i.test(ent.name)) out.push(p);
  }
  return out;
}

function collectTargets() {
  const out = [];
  const seen = new Set();
  for (const dir of DIST_NEXT_CANDIDATES) {
    const st = statSync(dir, { throwIfNoEntry: false });
    if (st?.isDirectory())
      for (const f of walk(dir))
        if (!seen.has(f)) {
          seen.add(f);
          out.push(f);
        }
  }
  return out;
}

// The needle: agentrouter GLM boolean-chain fragment with free identifier names.
// Produced by minifying something like:
//   ("agentrouter"===b&&z.toLowerCase().includes("glm"))
// Some builds wrap this in parentheses, some don't; some add `||` before/after.
// We build the pattern in parts so the capture groups are stable.
function buildMatcher() {
  const IDENT = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;
  return new RegExp(
    String.raw`(\("agentrouter"===(${IDENT})&&(${IDENT})\.toLowerCase\(\)\.includes\("glm"\)\))`,
    "g"
  );
}

function appendTokenRouterClause(match, providerIdent, modelIdent) {
  return `${match}||("tokenrouter"===${providerIdent}&&${modelIdent}.toLowerCase().includes("glm"))`;
}

function hasTokenRouterClauseNear(content, index, windowChars = 400) {
  // A tokenrouter clause produced by this patcher sits immediately after the
  // agentrouter clause anywhere within a small window; the source fix does the
  // same (identical chain placement). A loose check is enough.
  const window = content.slice(Math.max(0, index - 20), index + windowChars);
  return /"tokenrouter"===[A-Za-z_$][A-Za-z0-9_$]*&&[A-Za-z_$][A-Za-z0-9_$]*\.toLowerCase\(\)\.includes\("glm"\)/.test(
    window
  );
}

let patchedFiles = 0;
let patchedClauses = 0;
let alreadyPatched = 0;
let scanned = 0;

for (const file of collectTargets()) {
  scanned += 1;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const re = buildMatcher();
  let changed = false;
  content = content.replace(re, (match, _full, providerIdent, modelIdent, offset) => {
    if (hasTokenRouterClauseNear(content, offset)) {
      alreadyPatched += 1;
      return match; // already has our clause — leave alone
    }
    patchedClauses += 1;
    changed = true;
    return appendTokenRouterClause(match, providerIdent, modelIdent);
  });
  if (changed) {
    writeFileSync(file, content);
    patchedFiles += 1;
    console.log(`[postbuild-tokenrouter] patched ${file}`);
  }
}

if (patchedClauses > 0) {
  console.log(
    `[postbuild-tokenrouter] patched ${patchedClauses} clause site(s) across ${patchedFiles} file(s) (scanned ${scanned} js files)`
  );
} else if (alreadyPatched > 0) {
  console.log(
    `[postbuild-tokenrouter] already patched everywhere (${alreadyPatched} site(s)); no-op (scanned ${scanned} js files)`
  );
} else {
  console.log(
    `[postbuild-tokenrouter] no agentrouter-GLM reasoner chain found in ${scanned} js files — either a new build layout or the source fix is already compiled in; nothing to patch`
  );
}

process.exit(0);
