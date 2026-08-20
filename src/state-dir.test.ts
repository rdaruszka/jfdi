import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jfdiHome, projectKey, projectStateDirectory } from "./state-dir.js";

const ORIGINAL_JFDI_HOME = process.env.JFDI_HOME;

afterEach(() => {
  if (ORIGINAL_JFDI_HOME === undefined) delete process.env.JFDI_HOME;
  else process.env.JFDI_HOME = ORIGINAL_JFDI_HOME;
});

describe("projectKey", () => {
  it("dash-flattens an absolute path the way Claude Code keys its projects", () => {
    expect(projectKey("/Users/alice/dev/app")).toBe("-Users-alice-dev-app");
  });

  it("resolves relative paths against cwd before flattening", () => {
    expect(projectKey(".")).toBe(projectKey(process.cwd()));
  });

  it("collapses trailing separators", () => {
    expect(projectKey("/Users/alice/dev/app/")).toBe(projectKey("/Users/alice/dev/app"));
  });

  it("accepts the known ambiguity: a dash in a folder name reads as a separator", () => {
    expect(projectKey("/Users/alice/dev-app")).toBe(projectKey("/Users/alice/dev/app"));
  });
});

describe("projectStateDirectory", () => {
  it("lands under <home>/projects/<key>, leaving the rest of ~/.jfdi free", () => {
    process.env.JFDI_HOME = "/tmp/fake-home";
    expect(projectStateDirectory("/Users/alice/dev/app")).toBe(
      path.join("/tmp/fake-home", "projects", "-Users-alice-dev-app"),
    );
  });

  it("defaults to ~/.jfdi when JFDI_HOME is unset", () => {
    delete process.env.JFDI_HOME;
    expect(jfdiHome()).toBe(path.join(os.homedir(), ".jfdi"));
    expect(projectStateDirectory("/Users/alice/dev/app")).toBe(
      path.join(os.homedir(), ".jfdi", "projects", "-Users-alice-dev-app"),
    );
  });
});
