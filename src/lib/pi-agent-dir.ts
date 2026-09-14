import { homedir } from "node:os";
import { join } from "node:path";

export type PiAgentDirEnvironment = {
  readonly HOME?: string | undefined;
  readonly PI_CODING_AGENT_DIR?: string | undefined;
  readonly [key: string]: string | undefined;
};

export function resolvePiAgentDirectory(
  environment: PiAgentDirEnvironment = process.env,
  homeDirectory: () => string = homedir,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = () => nonempty(environment.HOME) ?? homeDirectory();
  const configured = nonempty(environment.PI_CODING_AGENT_DIR);
  if (configured === undefined) {
    return join(home(), ".pi", "agent");
  }
  if (configured === "~") return home();
  if (
    configured.startsWith("~/") ||
    (platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(home(), configured.slice(2));
  }
  return configured;
}

export function resolvePiAuthFilePath(
  environment: PiAgentDirEnvironment = process.env,
  homeDirectory: () => string = homedir,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(
    resolvePiAgentDirectory(environment, homeDirectory, platform),
    "auth.json",
  );
}

function nonempty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
