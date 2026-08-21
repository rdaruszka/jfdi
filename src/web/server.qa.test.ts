import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { EventLog } from "../events.js";
import type { SettingsSnapshot } from "../settings.js";
import { startWebFrontEnd, type WebFrontEnd, type WebSettingsSurface } from "./server.js";

// QA acceptance coverage for web-typography-refine: the served page must render
// its chrome in a proportional face at a 14px root, keeping monospace only on
// genuinely terminal-like content, with the dark colour scheme untouched.

let frontEnd: WebFrontEnd | null = null;

function memorySettings(): WebSettingsSurface {
  let snapshot: SettingsSnapshot = {
    config: defaultConfig(),
    editableConfig: { ...defaultConfig() },
    revision: "initial",
  };
  return {
    frontEndInEffect: () => "terminal",
    load: () => Promise.resolve(snapshot),
    save: (staged) => {
      snapshot = {
        config: staged as SettingsSnapshot["config"],
        editableConfig: staged as SettingsSnapshot["editableConfig"],
        revision: "saved",
      };
      return Promise.resolve(snapshot);
    },
  };
}

async function servedPage(): Promise<string> {
  frontEnd = await startWebFrontEnd({
    log: new EventLog("unused", false),
    projectRoot: "unused",
    ticketsDirectory: ".jfdi/tickets",
    boardName: "board.md",
    targetBranch: "main",
    integrationMode: "auto",
    settings: memorySettings(),
  });
  return await (await fetch(frontEnd.url)).text();
}

// The selectors of every CSS rule whose declaration block mentions "monospace".
function selectorsDeclaringMonospace(pageMarkup: string): string[] {
  const selectors: string[] = [];
  const rulePattern = /^\s*([^{}\n]+?)\s*\{([^}]*)\}/gm;
  for (const match of pageMarkup.matchAll(rulePattern)) {
    const selector = match[1];
    const declarations = match[2];
    if (selector !== undefined && declarations?.includes("monospace")) {
      selectors.push(selector.trim());
    }
  }
  return selectors;
}

afterEach(async () => {
  await frontEnd?.close();
  frontEnd = null;
});

describe("web typography acceptance", () => {
  it("reserves the monospace face for exactly the four terminal-like categories", async () => {
    const pageMarkup = await servedPage();

    // Adversarial: not "these four are mono" but "only these four are" — any new
    // rule that reintroduces monospace to the chrome fails this outright.
    expect(selectorsDeclaringMonospace(pageMarkup).sort()).toEqual(
      ["code", ".brand", ".detail-toolbar h1", ".feed-output"].sort(),
    );
  });

  it("makes the whole page proportional and smaller at the root", async () => {
    const pageMarkup = await servedPage();
    const rootRule = /:root \{([^}]*)\}/.exec(pageMarkup)?.[1] ?? "";

    expect(rootRule).toContain(
      'font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    );
    expect(rootRule).not.toContain("monospace");
    expect(rootRule).toContain("font-size: 14px");
    expect(rootRule).toContain("line-height: 1.5");
  });

  it("keeps the dark colour scheme intact", async () => {
    const pageMarkup = await servedPage();

    // Background, foreground, accent, and status colours the design must preserve.
    for (const colour of ["#0b0d10", "#edf1f7", "#78dce8", "#63d392", "#e5b567"]) {
      expect(pageMarkup).toContain(colour);
    }
  });

  it("lets board cards size to their content and stay legible", async () => {
    const pageMarkup = await servedPage();
    const cardRule = /\.card \{([^}]*)\}/.exec(pageMarkup)?.[1] ?? "";

    expect(cardRule).not.toContain("min-height");
    expect(cardRule).toContain("padding: .6rem .7rem");
    expect(cardRule).toContain("font-size: .86rem");
    // A card is a <button>, so it must inherit the proportional root, not stay mono.
    expect(cardRule).not.toContain("monospace");
  });

  it("still serves a working board page without horizontal overflow chrome", async () => {
    const pageMarkup = await servedPage();

    expect(pageMarkup).toContain('<div class="kanban" id="kanban"');
    expect(pageMarkup).toContain('class="feed-output"');
    expect(pageMarkup).toContain('id="pause"');
    expect(pageMarkup).toContain('id="settings-panel"');
    expect(/body \{[^}]*overflow-x: auto/.test(pageMarkup)).toBe(true);
  });
});
