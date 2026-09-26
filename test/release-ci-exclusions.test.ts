import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

/**
 * The status check context the no-mistakes gate publishes. The `main` ruleset
 * treats it as advisory, but the job name still has to stay exactly this so the
 * context contributors (and any future ruleset) look for keeps its identity.
 */
const gateCheckContext = "PR must be raised via no-mistakes";

/**
 * Derive the exact release-please output set from config + workflow inputs.
 * Keep this aligned with the fleet audit rule: node -> package.json
 * (+ package-lock.json if present), changelog, extra-files, and the manifest.
 */
function expectedReleaseOutputs(): string[] {
  const config = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf8"),
  ) as {
    "release-type"?: string;
    "changelog-path"?: string;
    "version-file"?: string;
    "extra-files"?: Array<string | { path?: string }>;
    packages?: Record<
      string,
      {
        "release-type"?: string;
        "changelog-path"?: string;
        "version-file"?: string;
        "extra-files"?: Array<string | { path?: string }>;
      }
    >;
  };

  const pkg = config.packages?.["."] ?? {};
  const releaseType = pkg["release-type"] ?? config["release-type"] ?? "node";
  const changelog =
    pkg["changelog-path"] ?? config["changelog-path"] ?? "CHANGELOG.md";

  const expected = [changelog];
  switch (releaseType) {
    case "simple":
      expected.push(
        pkg["version-file"] ?? config["version-file"] ?? "version.txt",
      );
      break;
    case "node":
      expected.push("package.json");
      if (existsSync(join(root, "package-lock.json"))) {
        expected.push("package-lock.json");
      }
      break;
    case "go":
      break;
    default:
      throw new Error(
        `unsupported release-please release-type for ignore derivation: ${releaseType}`,
      );
  }

  const extra = pkg["extra-files"] ?? config["extra-files"] ?? [];
  for (const entry of extra) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (path) expected.push(path);
  }

  let manifest = ".release-please-manifest.json";
  const releaseWorkflow = readFileSync(
    join(workflowsDir, "release-please.yml"),
    "utf8",
  );
  const manifestMatch = releaseWorkflow.match(/manifest-file:\s*(\S+)/);
  if (manifestMatch) manifest = manifestMatch[1];
  expected.push(manifest);

  return [...new Set(expected)];
}

function loadWorkflowOn(filePath: string): Record<string, unknown> | null {
  const doc = loadYaml(readFileSync(filePath, "utf8")) as
    | Record<string | boolean, unknown>
    | null
    | undefined;
  // js-yaml may parse a bare `on:` key as boolean true.
  const on = doc?.on ?? doc?.true ?? null;
  if (on == null || typeof on !== "object" || Array.isArray(on)) return null;
  return on as Record<string, unknown>;
}

type PathFilter =
  | { kind: "unfiltered" }
  | { kind: "paths-ignore"; paths: string[] }
  | { kind: "paths"; paths: string[] };

function pullRequestFilterCoverage(pr: unknown): PathFilter {
  if (pr == null) {
    return { kind: "unfiltered" };
  }
  if (typeof pr !== "object" || Array.isArray(pr)) {
    // `pull_request:` bare form means no path filter.
    return { kind: "unfiltered" };
  }

  const record = pr as Record<string, unknown>;
  if (Array.isArray(record["paths-ignore"])) {
    return {
      kind: "paths-ignore",
      paths: record["paths-ignore"].map(String),
    };
  }

  if (Array.isArray(record.paths)) {
    return { kind: "paths", paths: record.paths.map(String) };
  }

  return { kind: "unfiltered" };
}

function globMatch(pattern: string, path: string): boolean {
  // Minimal support for the `**` / `*` patterns used in workflow path filters.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function isCovered(filter: PathFilter, releasePath: string): boolean {
  if (filter.kind === "unfiltered") return false;

  if (filter.kind === "paths-ignore") {
    return filter.paths.includes(releasePath);
  }

  // paths allow-list: a release path is "covered" (will not create a run on its
  // own) when no positive pattern matches it, or a later negation excludes it.
  let matched = false;
  for (const pattern of filter.paths) {
    if (pattern.startsWith("!")) {
      const negated = pattern.slice(1);
      if (
        matched &&
        (negated === releasePath || globMatch(negated, releasePath))
      ) {
        matched = false;
      }
      continue;
    }
    if (pattern === releasePath || globMatch(pattern, releasePath)) {
      matched = true;
    }
  }
  // Covered means the path does NOT cause the workflow to run.
  return !matched;
}

/**
 * A workflow "backs the gate check" when one of its jobs publishes that
 * context, i.e. its job `name` is exactly the context. Such a workflow is the
 * one place a `paths`/`paths-ignore` filter is forbidden rather than mandatory:
 * the gate judges the pull request body, not the files it touches, so a path
 * filter would drop it on exactly the pull requests still needing judgement.
 */
function publishesGateCheck(filePath: string): boolean {
  const doc = loadYaml(readFileSync(filePath, "utf8")) as
    | { jobs?: Record<string, { name?: unknown }> }
    | null
    | undefined;
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") return false;
  return Object.values(jobs).some((job) => job?.name === gateCheckContext);
}

type PullRequestWorkflow = {
  name: string;
  filter: PathFilter;
  backsGateCheck: boolean;
};

type ExpressionNode =
  | { kind: "literal"; value: string | boolean }
  | { kind: "reference"; path: string[] }
  | { kind: "not"; operand: ExpressionNode }
  | {
      kind: "binary";
      operator: "&&" | "||" | "==" | "!=";
      left: ExpressionNode;
      right: ExpressionNode;
    };

type ExpressionToken =
  | { kind: "literal"; value: string | boolean }
  | { kind: "reference"; value: string }
  | { kind: "operator"; value: "&&" | "||" | "==" | "!=" | "!" }
  | { kind: "paren"; value: "(" | ")" };

function tokenizeExpression(expression: string): ExpressionToken[] {
  const tokens: ExpressionToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    const pair = expression.slice(index, index + 2);
    if (pair === "&&" || pair === "||" || pair === "==" || pair === "!=") {
      tokens.push({ kind: "operator", value: pair });
      index += 2;
      continue;
    }
    if (character === "!") {
      tokens.push({ kind: "operator", value: "!" });
      index += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      tokens.push({ kind: "paren", value: character });
      index += 1;
      continue;
    }
    if (character === "'") {
      let value = "";
      index += 1;
      while (index < expression.length && expression[index] !== "'") {
        value += expression[index];
        index += 1;
      }
      if (expression[index] !== "'") throw new Error("unterminated string");
      tokens.push({ kind: "literal", value });
      index += 1;
      continue;
    }

    const start = index;
    while (
      index < expression.length &&
      /[A-Za-z0-9_.-]/.test(expression[index]!)
    ) {
      index += 1;
    }
    if (start === index) {
      throw new Error(`unsupported expression token at ${index}`);
    }
    const value = expression.slice(start, index);
    if (value === "true" || value === "false") {
      tokens.push({ kind: "literal", value: value === "true" });
    } else {
      tokens.push({ kind: "reference", value });
    }
  }
  return tokens;
}

function parseExpression(expression: string): ExpressionNode {
  const tokens = tokenizeExpression(expression);
  let index = 0;

  function parsePrimary(): ExpressionNode {
    const token = tokens[index++];
    if (!token) throw new Error("unexpected end of expression");
    if (token.kind === "literal")
      return { kind: "literal", value: token.value };
    if (token.kind === "reference") {
      return { kind: "reference", path: token.value.split(".") };
    }
    if (token.kind === "operator" && token.value === "!") {
      return { kind: "not", operand: parsePrimary() };
    }
    if (token.kind === "paren" && token.value === "(") {
      const node = parseOr();
      const close = tokens[index++];
      if (close?.kind !== "paren" || close.value !== ")") {
        throw new Error("missing closing parenthesis");
      }
      return node;
    }
    throw new Error("unexpected expression token");
  }

  function parseEquality(): ExpressionNode {
    let node = parsePrimary();
    while (
      tokens[index]?.kind === "operator" &&
      (tokens[index].value === "==" || tokens[index].value === "!=")
    ) {
      const operator = tokens[index++].value as "==" | "!=";
      node = { kind: "binary", operator, left: node, right: parsePrimary() };
    }
    return node;
  }

  function parseAnd(): ExpressionNode {
    let node = parseEquality();
    while (tokens[index]?.kind === "operator" && tokens[index].value === "&&") {
      index += 1;
      node = {
        kind: "binary",
        operator: "&&",
        left: node,
        right: parseEquality(),
      };
    }
    return node;
  }

  function parseOr(): ExpressionNode {
    let node = parseAnd();
    while (tokens[index]?.kind === "operator" && tokens[index].value === "||") {
      index += 1;
      node = { kind: "binary", operator: "||", left: node, right: parseAnd() };
    }
    return node;
  }

  const node = parseOr();
  if (index !== tokens.length)
    throw new Error("unexpected trailing expression token");
  return node;
}

function evaluateExpression(
  node: ExpressionNode,
  context: Record<string, unknown>,
): string | boolean | undefined {
  if (node.kind === "literal") return node.value;
  if (node.kind === "reference") {
    let value: unknown = context;
    for (const segment of node.path) {
      if (value == null || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[segment];
    }
    return typeof value === "string" || typeof value === "boolean"
      ? value
      : undefined;
  }
  if (node.kind === "not") return !evaluateExpression(node.operand, context);

  const left = evaluateExpression(node.left, context);
  if (node.operator === "&&") {
    return Boolean(left) && Boolean(evaluateExpression(node.right, context));
  }
  if (node.operator === "||") {
    return Boolean(left) || Boolean(evaluateExpression(node.right, context));
  }
  const right = evaluateExpression(node.right, context);
  return node.operator === "==" ? left === right : left !== right;
}

function gateRunsForAuthor(expression: ExpressionNode, login: string): boolean {
  return Boolean(
    evaluateExpression(expression, {
      github: { event: { pull_request: { user: { login } } } },
    }),
  );
}

function pullRequestWorkflows(): PullRequestWorkflow[] {
  const out: PullRequestWorkflow[] = [];
  for (const name of readdirSync(workflowsDir).filter((n) =>
    n.endsWith(".yml"),
  )) {
    const filePath = join(workflowsDir, name);
    const on = loadWorkflowOn(filePath);
    if (!on || !("pull_request" in on)) continue;
    out.push({
      name,
      filter: pullRequestFilterCoverage(on.pull_request),
      backsGateCheck: publishesGateCheck(filePath),
    });
  }
  return out;
}

describe("release-please CI exclusions", () => {
  const expected = expectedReleaseOutputs();

  it("derives the node release-output set for this repository", () => {
    expect(expected).toEqual([
      "CHANGELOG.md",
      "package.json",
      ".release-please-manifest.json",
    ]);
  });

  it("splits pull_request workflows into the gate and the rest", () => {
    const prWorkflows = pullRequestWorkflows();

    // The gate is the single intentional exception to the paths-ignore rule.
    expect(
      prWorkflows.filter((w) => w.backsGateCheck).map((w) => w.name),
    ).toEqual(["no-mistakes-required.yml"]);

    // Everything else still owes the release-output exclusion.
    expect(
      prWorkflows
        .filter((w) => !w.backsGateCheck)
        .map((w) => w.name)
        .sort(),
    ).toEqual(["ci.yml", "guard-generated-files.yml"]);
  });

  it("every non-gate pull_request workflow ignores the full release-output set", () => {
    const others = pullRequestWorkflows().filter((w) => !w.backsGateCheck);
    expect(others.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const { name, filter } of others) {
      const missing = expected.filter((path) => !isCovered(filter, path));
      if (missing.length > 0) {
        failures.push(`${name} missing coverage for: ${missing.join(", ")}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("the workflow backing the gate check carries no path filter", () => {
    // The gate's verdict is a function of the pull request body, not of the
    // files it touches, so a path filter would silently drop the gate on
    // exactly the pull requests whose bodies still need judging.
    const gates = pullRequestWorkflows().filter((w) => w.backsGateCheck);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.filter).toEqual({ kind: "unfiltered" });
  });

  it("the gate is a thin caller of the shared composite action", () => {
    // Enforcement lives upstream in kunchenguid/no-mistakes, pinned to an
    // immutable commit so the pull request being judged cannot move it.
    const doc = loadYaml(
      readFileSync(join(workflowsDir, "no-mistakes-required.yml"), "utf8"),
    ) as {
      jobs?: Record<
        string,
        {
          name?: unknown;
          if?: unknown;
          steps?: Array<{ uses?: unknown; run?: unknown }>;
        }
      >;
    };
    const gateJobs = Object.values(doc.jobs ?? {}).filter(
      (job) => job?.name === gateCheckContext,
    );
    expect(gateJobs).toHaveLength(1);

    const steps = gateJobs[0]!.steps ?? [];
    expect(steps.map((step) => step.uses)).toEqual([
      "kunchenguid/no-mistakes/.github/actions/require-no-mistakes@f6441c96c352a18b9cadcaef6b6c7017e9ac3970",
    ]);
    // No local enforcement copy, and nothing checked out to run it from.
    expect(steps.some((step) => typeof step.run === "string")).toBe(false);
  });

  it("exempts the automation authors at the job level", () => {
    // release-please opens its release PR as github-actions[bot], so the author
    // exemption alone skips the gate job on release PRs; the old structural
    // release-please exemption and its status-stamping job are gone.
    const doc = loadYaml(
      readFileSync(join(workflowsDir, "no-mistakes-required.yml"), "utf8"),
    ) as { jobs?: Record<string, { name?: unknown; if?: unknown }> };
    const gateJob = Object.values(doc.jobs ?? {}).find(
      (job) => job?.name === gateCheckContext,
    );
    expect(typeof gateJob?.if).toBe("string");
    const condition = parseExpression(String(gateJob!.if));
    expect(gateRunsForAuthor(condition, "github-actions[bot]")).toBe(false);
    expect(gateRunsForAuthor(condition, "dependabot[bot]")).toBe(false);
    expect(gateRunsForAuthor(condition, "human-contributor")).toBe(true);
    expect(gateRunsForAuthor(condition, "renovate[bot]")).toBe(true);

    // The release workflow no longer stamps a gate status of its own.
    const releaseDoc = loadYaml(
      readFileSync(join(workflowsDir, "release-please.yml"), "utf8"),
    ) as { jobs?: Record<string, { name?: unknown }> };
    expect(Object.keys(releaseDoc.jobs ?? {})).toEqual(["release-please"]);
  });

  it("does not attach path filters to non-pull_request triggers on ci.yml", () => {
    const on = loadWorkflowOn(join(workflowsDir, "ci.yml"));
    expect(on).not.toBeNull();
    expect(on!.push).toEqual({ branches: ["main"] });
    const pr = on!.pull_request as Record<string, unknown>;
    expect(pr.branches).toEqual(["main"]);
    expect(pr["paths-ignore"]).toEqual([
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package.json",
    ]);
    expect(on!.release).toBeUndefined();
    expect(on!.workflow_dispatch).toBeUndefined();
  });
});
