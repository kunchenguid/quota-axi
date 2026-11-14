import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  piListedProfiles,
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

describe("piListedProfiles", () => {
  it("is undefined when the variable is unset, blank, or only delimiters", () => {
    expect(piListedProfiles({})).toBeUndefined();
    expect(piListedProfiles({ QUOTA_AXI_PI_PROFILES: "  " })).toBeUndefined();
    expect(
      piListedProfiles({ QUOTA_AXI_PI_PROFILES: `${delimiter}${delimiter}` }),
    ).toBeUndefined();
  });

  it("keeps absolute entries in order and separates relative ones", () => {
    const first = join("/", "home", "user", ".pi-work");
    const second = join("/", "home", "user", ".pi-team");
    expect(
      piListedProfiles({
        QUOTA_AXI_PI_PROFILES: [first, "", "relative/pi", second].join(
          delimiter,
        ),
      }),
    ).toEqual({ dirs: [first, second], invalid: ["relative/pi"] });
  });
});
