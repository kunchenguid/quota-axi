import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolvePiAgentDirectory,
  resolvePiAuthFilePath,
} from "../../src/lib/pi-agent-dir.js";

describe("resolvePiAgentDirectory", () => {
  it("defaults to ~/.pi/agent", () => {
    expect(resolvePiAgentDirectory({}, () => "/home/user", "linux")).toBe(
      join("/home/user", ".pi", "agent"),
    );
  });

  it("honors PI_CODING_AGENT_DIR absolute paths", () => {
    expect(
      resolvePiAgentDirectory(
        { PI_CODING_AGENT_DIR: "/custom/pi" },
        () => "/home/user",
        "linux",
      ),
    ).toBe("/custom/pi");
  });

  it("expands ~ and ~/", () => {
    expect(
      resolvePiAgentDirectory(
        { PI_CODING_AGENT_DIR: "~" },
        () => "/home/user",
        "linux",
      ),
    ).toBe("/home/user");
    expect(
      resolvePiAgentDirectory(
        { PI_CODING_AGENT_DIR: "~/agent-data" },
        () => "/home/user",
        "linux",
      ),
    ).toBe(join("/home/user", "agent-data"));
  });

  it("expands ~\\ on Windows", () => {
    expect(
      resolvePiAgentDirectory(
        { PI_CODING_AGENT_DIR: "~\\agent-data" },
        () => "C:\\Users\\user",
        "win32",
      ),
    ).toBe(join("C:\\Users\\user", "agent-data"));
  });

  it("prefers HOME over the homeDirectory fallback", () => {
    expect(
      resolvePiAgentDirectory(
        { HOME: "/alt/home", PI_CODING_AGENT_DIR: "~/agent" },
        () => "/home/user",
        "linux",
      ),
    ).toBe(join("/alt/home", "agent"));
  });
});

describe("resolvePiAuthFilePath", () => {
  it("appends auth.json under the agent directory", () => {
    expect(
      resolvePiAuthFilePath(
        { PI_CODING_AGENT_DIR: "/custom/pi" },
        () => "/home/user",
        "linux",
      ),
    ).toBe(join("/custom/pi", "auth.json"));
    expect(resolvePiAuthFilePath({}, () => homedir())).toBe(
      join(homedir(), ".pi", "agent", "auth.json"),
    );
  });
});
