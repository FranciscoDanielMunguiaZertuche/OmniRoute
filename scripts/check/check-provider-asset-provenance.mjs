#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? resolve(process.argv[index + 1]) : fallback;
}

const providersDir = readOption("--providers-dir", join(repoRoot, "public/providers"));
const manifestPath = readOption(
  "--manifest",
  join(repoRoot, "config/quality/provider-assets-provenance.jsonl")
);
const PROVENANCE_STATUSES = new Set(["proven", "probable", "unresolved"]);

function detectMediaType(content) {
  const pngSignature = "89504e470d0a1a0a";
  if (content.length >= 8 && content.subarray(0, 8).toString("hex") === pngSignature) {
    return "image/png";
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return "image/jpeg";
  }

  const text = content
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (
    /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[\s\S]*?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(
      text
    )
  ) {
    return "image/svg+xml";
  }
  return null;
}

function hasImmutableSourceEvidence(source) {
  if (!source || typeof source !== "object") return false;
  if (!new Set(["git", "npm"]).has(source.kind)) return false;
  if (typeof source.url !== "string" || !source.url.startsWith("https://")) return false;
  if (typeof source.path !== "string" || source.path.length === 0) return false;
  if (!new Set(["byte-exact", "svg-path-data"]).has(source.match)) return false;
  if (source.kind === "git") {
    return /^[0-9a-f]{40}$/i.test(source.ref) && /^sha256:[0-9a-f]{64}$/.test(source.integrity);
  }
  return (
    /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(source.ref) &&
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(source.integrity) &&
    /^[0-9a-f]{40}$/i.test(source.packageShasum)
  );
}

function isValidUpstreamLicenseClaim(claim) {
  if (claim === null) return true;
  return (
    typeof claim === "object" &&
    typeof claim.value === "string" &&
    claim.value.length > 0 &&
    typeof claim.assertedBy === "string" &&
    claim.assertedBy.length > 0 &&
    typeof claim.evidence === "string" &&
    claim.evidence.startsWith("https://") &&
    typeof claim.independentlyVerified === "boolean" &&
    typeof claim.scope === "string" &&
    /no trademark clearance/i.test(claim.scope)
  );
}

async function readManifest(path) {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSON on manifest line ${index + 1}: ${error.message}`);
      }
    });
}

async function main() {
  const records = await readManifest(manifestPath);
  const headers = records.filter((record) => record.recordType === "manifest");
  const assets = records.filter((record) => record.recordType === "asset");
  const aliases = records.filter((record) => record.recordType === "contentAlias");
  const providerEntries = await readdir(providersDir, { withFileTypes: true });
  const physicalFiles = providerEntries
    .filter((entry) => entry.isFile())
    .map((entry) => `public/providers/${entry.name}`)
    .sort();
  const nonRegularPaths = providerEntries
    .filter((entry) => !entry.isFile())
    .map((entry) => `public/providers/${entry.name}`)
    .sort();
  const manifestPaths = new Set(assets.map((asset) => asset.path));
  const physicalPaths = new Set(physicalFiles);
  const failures = [];
  const pathsBySha256 = new Map();

  for (const path of nonRegularPaths) {
    failures.push(`non-regular provider asset entry is not allowed: ${path}`);
  }

  if (headers.length !== 1 || records[0]?.recordType !== "manifest") {
    failures.push("manifest must contain exactly one recordType=manifest header on line 1");
  }
  const header = headers[0];
  if (header) {
    if (header.schemaVersion !== 1) {
      failures.push(`unsupported schemaVersion: ${header.schemaVersion}`);
    }
    if (
      header.expectedAssetCount !== assets.length ||
      header.expectedAssetCount !== physicalFiles.length
    ) {
      failures.push(
        `expectedAssetCount mismatch: manifest ${header.expectedAssetCount}, ` +
          `records ${assets.length}, physical ${physicalFiles.length}`
      );
    }
    if (typeof header.auditedCommit !== "string" || !/^[0-9a-f]{40}$/i.test(header.auditedCommit)) {
      failures.push("manifest auditedCommit must be a full 40-character Git SHA");
    }
    if (typeof header.auditedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(header.auditedAt)) {
      failures.push("manifest auditedAt must use YYYY-MM-DD");
    }
    if (
      typeof header.legalScope !== "string" ||
      !header.legalScope.includes("does not establish copyright or trademark clearance")
    ) {
      failures.push("manifest legalScope must disclaim copyright and trademark clearance");
    }
  }
  for (const record of records) {
    if (!new Set(["manifest", "asset", "contentAlias"]).has(record.recordType)) {
      failures.push(`unknown manifest recordType: ${record.recordType}`);
    }
  }

  const pathRecordCounts = new Map();
  for (const asset of assets) {
    pathRecordCounts.set(asset.path, (pathRecordCounts.get(asset.path) ?? 0) + 1);
  }
  for (const [path, count] of pathRecordCounts) {
    if (count > 1) failures.push(`duplicate manifest asset path: ${path}`);
  }

  for (const path of physicalFiles) {
    if (!manifestPaths.has(path)) failures.push(`missing from manifest: ${path}`);
  }
  for (const path of manifestPaths) {
    if (!physicalPaths.has(path)) failures.push(`manifest path missing on disk: ${path}`);
  }
  for (const asset of assets) {
    if (typeof asset.path !== "string" || !/^public\/providers\/[^/]+$/.test(asset.path)) {
      failures.push(`invalid provider asset path: ${asset.path}`);
    }
    if (typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      failures.push(`invalid sha256 for ${asset.path}`);
    }
    if (!new Set(["image/svg+xml", "image/png", "image/jpeg"]).has(asset.mediaType)) {
      failures.push(`invalid mediaType for ${asset.path}: ${asset.mediaType}`);
    }
    if (!PROVENANCE_STATUSES.has(asset.provenanceStatus)) {
      failures.push(`invalid provenanceStatus for ${asset.path}: ${asset.provenanceStatus}`);
    }
    if (asset.provenanceStatus === "proven" && !hasImmutableSourceEvidence(asset.source)) {
      failures.push(`proven asset requires immutable source evidence: ${asset.path}`);
    }
    if (
      asset.provenanceStatus === "proven" &&
      asset.source?.match === "byte-exact" &&
      asset.source.integrity !== `sha256:${asset.sha256}`
    ) {
      failures.push(`byte-exact source integrity must match local sha256: ${asset.path}`);
    }
    if (
      asset.provenanceStatus === "proven" &&
      asset.source?.match === "svg-path-data" &&
      (typeof asset.source.matchDetail !== "string" || asset.source.matchDetail.length === 0)
    ) {
      failures.push(`svg-path-data source requires matchDetail: ${asset.path}`);
    }
    if (!isValidUpstreamLicenseClaim(asset.upstreamLicenseClaim)) {
      failures.push(`invalid upstreamLicenseClaim for ${asset.path}`);
    }
    if (new Set(["probable", "unresolved"]).has(asset.provenanceStatus) && asset.source !== null) {
      failures.push(`${asset.provenanceStatus} asset source must be null: ${asset.path}`);
    }
    if (
      new Set(["probable", "unresolved"]).has(asset.provenanceStatus) &&
      asset.upstreamLicenseClaim !== null
    ) {
      failures.push(`${asset.provenanceStatus} asset license claim must be null: ${asset.path}`);
    }
    if (asset.trademarkClearance !== null) {
      failures.push(`trademarkClearance must remain null: ${asset.path}`);
    }
    if (typeof asset.evidenceNote !== "string" || asset.evidenceNote.trim().length === 0) {
      failures.push(`evidenceNote is required: ${asset.path}`);
    }
    if (!physicalPaths.has(asset.path)) continue;
    const fileName = asset.path.slice("public/providers/".length);
    const content = await readFile(join(providersDir, fileName));
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    const matchingPaths = pathsBySha256.get(actualSha256) ?? [];
    matchingPaths.push(asset.path);
    pathsBySha256.set(actualSha256, matchingPaths);
    if (asset.sha256 !== actualSha256) {
      failures.push(`sha256 mismatch: ${asset.path}`);
    }
    const actualMediaType = detectMediaType(content);
    if (asset.mediaType !== actualMediaType) {
      failures.push(
        `mediaType mismatch: ${asset.path} (manifest ${asset.mediaType}, actual ${actualMediaType ?? "unknown"})`
      );
    }
  }

  const aliasesBySha256 = new Map();
  for (const alias of aliases) {
    if (aliasesBySha256.has(alias.sha256)) {
      failures.push(`duplicate contentAlias record: sha256:${alias.sha256}`);
      continue;
    }
    aliasesBySha256.set(alias.sha256, alias);
  }
  for (const [sha256, paths] of pathsBySha256) {
    if (paths.length < 2) continue;
    const alias = aliasesBySha256.get(sha256);
    if (!alias) {
      failures.push(`duplicate content missing alias record: sha256:${sha256}`);
      continue;
    }
    const declaredPaths = [alias.canonicalPath, ...(alias.aliases ?? [])].sort();
    const actualPaths = [...paths].sort();
    if (JSON.stringify(declaredPaths) !== JSON.stringify(actualPaths)) {
      failures.push(`contentAlias paths mismatch: sha256:${sha256}`);
    }
  }
  for (const alias of aliases) {
    if ((pathsBySha256.get(alias.sha256) ?? []).length < 2) {
      failures.push(`contentAlias does not describe duplicate content: sha256:${alias.sha256}`);
    }
  }

  if (failures.length > 0) {
    console.error("Provider asset provenance failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  const statusCounts = { proven: 0, probable: 0, unresolved: 0 };
  for (const asset of assets) statusCounts[asset.provenanceStatus] += 1;
  const duplicateGroupCount = [...pathsBySha256.values()].filter(
    (paths) => paths.length > 1
  ).length;
  console.log(
    `Provider asset provenance passed: ${assets.length}/${physicalFiles.length} registered; ` +
      `proven=${statusCounts.proven} probable=${statusCounts.probable} ` +
      `unresolved=${statusCounts.unresolved}; duplicate-groups=${duplicateGroupCount}.`
  );
}

main().catch((error) => {
  console.error(`Provider asset provenance failed: ${error.message}`);
  process.exitCode = 1;
});
