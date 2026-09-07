import { homedir } from "node:os";
import { join } from "node:path";

export function piAuthFilePath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const home = process.env.HOME?.trim() || homedir();
  const directory =
    configured === undefined || configured === ""
      ? join(home, ".pi", "agent")
      : configured === "~"
        ? home
        : configured.startsWith("~/")
          ? join(home, configured.slice(2))
          : configured.startsWith("~\\")
            ? join(home, configured.slice(2))
            : configured;
  return join(directory, "auth.json");
}
