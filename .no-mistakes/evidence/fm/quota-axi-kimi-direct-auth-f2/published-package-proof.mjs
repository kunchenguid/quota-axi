import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtureRoot = mkdtempSync(join(tmpdir(), "quota-axi-package-evidence-"));
const extractedRoot = join(fixtureRoot, "extracted");
const forbiddenPackage = /@earendil-works\/pi-(?:ai|coding-agent)/;

try {
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", fixtureRoot],
    { cwd: resolve("."), encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const packReport = JSON.parse(packed.stdout)[0];
  const archivePath = join(fixtureRoot, packReport.filename);
  mkdirSync(extractedRoot, { mode: 0o700 });
  const extracted = spawnSync(
    "tar",
    ["-xzf", archivePath, "-C", extractedRoot],
    { encoding: "utf8" },
  );
  if (extracted.status !== 0) throw new Error(extracted.stderr);

  const manifest = JSON.parse(
    readFileSync(join(extractedRoot, "package", "package.json"), "utf8"),
  );
  const productionTree = spawnSync(
    "pnpm",
    ["list", "--prod", "--depth", "Infinity", "--json"],
    { cwd: resolve("."), encoding: "utf8" },
  );
  if (productionTree.status !== 0) {
    throw new Error(productionTree.stderr || productionTree.stdout);
  }

  const contentMatches = scan(join(extractedRoot, "package"));
  const dependencyNames = Object.keys(manifest.dependencies ?? {});
  const treeMatches = JSON.stringify(JSON.parse(productionTree.stdout)).match(
    forbiddenPackage,
  );
  if (dependencyNames.some((name) => forbiddenPackage.test(name))) {
    throw new Error("removed package remains in published dependencies");
  }
  if (contentMatches.length > 0) {
    throw new Error(`removed package remains in payload: ${contentMatches.join(", ")}`);
  }
  if (treeMatches) throw new Error("removed package remains in production tree");

  console.log("Command: npm pack --json --ignore-scripts");
  console.log(`Package: ${manifest.name}@${manifest.version}`);
  console.log(`Packed files: ${packReport.entryCount}`);
  console.log(`Packed size: ${packReport.size} bytes`);
  console.log(`Published dependencies: ${dependencyNames.join(", ")}`);
  console.log("Removed Pi SDK dependencies in manifest: none");
  console.log("Removed Pi SDK references in packed payload: none");
  console.log("Removed Pi SDK packages in installed production dependency tree: none");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function scan(directory) {
  const matches = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      matches.push(...scan(path));
      continue;
    }
    if (forbiddenPackage.test(readFileSync(path, "utf8"))) matches.push(path);
  }
  return matches;
}
