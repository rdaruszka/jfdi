import * as vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { EventLog } from "../events.js";
import type { SettingsSnapshot } from "../settings.js";
import { startWebFrontEnd, type WebFrontEnd, type WebSettingsSurface } from "./server.js";

// QA acceptance for the settings-escape-closes ticket: pressing Escape while the
// settings panel is open must close it exactly like Cancel — dismissing the
// panel and discarding staged edits — while doing nothing when it is closed.
//
// The behavior under test is browser JS embedded in the served page. Rather than
// assert on the source text (which cannot fail when the logic breaks), these
// tests extract the real shipped `handleSettingsKeydown` and `cancelSettings`
// functions from the served markup and execute them against a minimal DOM stub,
// driving actual keydown events and observing the resulting panel/staged state.

let frontEnd: WebFrontEnd | null = null;

function memorySettings(): WebSettingsSurface {
  const snapshot: SettingsSnapshot = {
    config: defaultConfig(),
    editableConfig: { ...defaultConfig() },
    revision: "initial",
  };
  return {
    frontEndInEffect: () => "terminal",
    load: () => Promise.resolve(snapshot),
    save: () => Promise.resolve(snapshot),
  };
}

afterEach(async () => {
  await frontEnd?.close();
  frontEnd = null;
});

async function servedPage(): Promise<string> {
  const log = new EventLog("unused", false);
  frontEnd = await startWebFrontEnd({
    log,
    projectRoot: "unused",
    ticketsDirectory: ".jfdi/tickets",
    boardName: "board.md",
    targetBranch: "main",
    integrationMode: "on-approval",
    settings: memorySettings(),
  });
  const page = await fetch(frontEnd.url);
  return page.text();
}

// Pull a top-level `function name(...) { ... }` block out of the page verbatim.
// The client functions are emitted at a fixed 4-space indent, so the block ends
// at the first closing brace on its own 4-space-indented line.
function extractFunction(page: string, name: string): string {
  const start = page.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`served page has no ${name} function to test`);
  const end = page.indexOf("\n    }", start);
  if (end === -1) throw new Error(`could not find the end of ${name} in the served page`);
  return page.slice(start, end + "\n    }".length);
}

interface StubElement {
  hidden: boolean;
  textContent: string;
  className: string;
  replaceChildren: () => void;
}

interface Sandbox {
  settingsRevision: string;
  settingsBaseConfig: unknown;
  settingsMessages: string[];
  elements: Map<string, StubElement>;
  element: (id: string) => StubElement;
  settingsMessage: (message: string) => void;
  keydown?: (event: { key: string }) => void;
}

function makeSandbox(panelHidden: boolean): Sandbox {
  const elements = new Map<string, StubElement>();
  const element = (id: string): StubElement => {
    let node = elements.get(id);
    if (node === undefined) {
      node = {
        hidden: id === "settings-panel" ? panelHidden : false,
        textContent: "",
        className: "",
        replaceChildren: () => {
          /* staged rows are irrelevant to the panel-close behavior under test */
        },
      };
      elements.set(id, node);
    }
    return node;
  };
  const settingsMessages: string[] = [];
  const sandbox: Sandbox = {
    // Staged, unsaved edits: a non-empty revision and a base config in memory.
    settingsRevision: "revision-from-disk",
    settingsBaseConfig: { edited: "staged but unsaved" },
    settingsMessages,
    elements,
    element,
    // Bare-called from cancelSettings, so it must not depend on `this`.
    settingsMessage: (message: string) => {
      settingsMessages.push(message);
    },
  };
  return sandbox;
}

function runKeydown(page: string, panelHidden: boolean, event: { key: string }): Sandbox {
  const sandbox = makeSandbox(panelHidden);
  const context = vm.createContext(sandbox);
  const source = [
    extractFunction(page, "cancelSettings"),
    extractFunction(page, "handleSettingsKeydown"),
    "handleSettingsKeydown(currentEvent);",
  ].join("\n");
  vm.runInContext(`var currentEvent = ${JSON.stringify(event)};\n${source}`, context);
  return sandbox;
}

describe("settings panel Escape-to-cancel", () => {
  it("closes the open panel and discards staged edits, exactly like Cancel", async () => {
    const page = await servedPage();
    const afterEscape = runKeydown(page, false, { key: "Escape" });

    // Panel dismissed, returning the user to the board.
    expect(afterEscape.element("settings-panel").hidden).toBe(true);
    // Staged edits discarded so a reopen re-reads disk, not the abandoned edits.
    expect(afterEscape.settingsRevision).toBe("");
    expect(afterEscape.settingsBaseConfig).toBeNull();

    // Prove Escape's effect is byte-for-byte the Cancel button's effect: the
    // page wires the Cancel click to cancelSettings, and Escape routes through
    // the same function.
    const afterCancel = runKeydown(page, false, { key: "Escape" });
    expect(page).toContain('element("settings-cancel").addEventListener("click", cancelSettings)');
    expect(afterEscape.element("settings-panel").hidden).toBe(
      afterCancel.element("settings-panel").hidden,
    );
    expect(afterEscape.settingsRevision).toBe(afterCancel.settingsRevision);
    expect(afterEscape.settingsBaseConfig).toEqual(afterCancel.settingsBaseConfig);
  });

  it("does nothing when the panel is already closed", async () => {
    const page = await servedPage();
    const afterEscape = runKeydown(page, true, { key: "Escape" });

    // Panel stays closed; staged state is untouched (not opened, not cleared).
    expect(afterEscape.element("settings-panel").hidden).toBe(true);
    expect(afterEscape.settingsRevision).toBe("revision-from-disk");
    expect(afterEscape.settingsBaseConfig).toEqual({ edited: "staged but unsaved" });
    expect(afterEscape.settingsMessages).toEqual([]);
  });

  it("ignores non-Escape keys while the panel is open", async () => {
    const page = await servedPage();
    for (const key of ["Enter", "a", "Tab", "Esc", " "]) {
      const afterKey = runKeydown(page, false, { key });
      expect(afterKey.element("settings-panel").hidden).toBe(false);
      expect(afterKey.settingsRevision).toBe("revision-from-disk");
      expect(afterKey.settingsBaseConfig).toEqual({ edited: "staged but unsaved" });
    }
  });

  it("registers the handler at the window level so any focused control can trigger it", async () => {
    const page = await servedPage();
    expect(page).toContain('window.addEventListener("keydown", handleSettingsKeydown)');
  });
});
