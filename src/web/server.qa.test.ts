/**
 * QA acceptance coverage for the "kanban view fills the window" ticket
 * (web-kanban-board-layout). Derived from the ticket's acceptance criteria,
 * not from the diff, and asserted against the page the real front end serves
 * over loopback.
 *
 * The behaviour under test is layout, whose ground truth is a rendered browser
 * — this session verified every criterion by rendering the served page in
 * headless Chrome (viewport owns both scrollbars; short columns reach the
 * window bottom; tall columns grow the page, never scroll on their own). The
 * gate has no browser, so these tests pin the CSS *contract that produces* that
 * behaviour: which element owns the horizontal scroll, which elements carry
 * fill/border, and which element is the stretching remainder. A regression that
 * silently reverts any of those (scroll back on .kanban, a box around a column,
 * a per-column overflow) fails here with the criterion it breaks named.
 */
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { EventLog } from "../events.js";
import type { SettingsSnapshot } from "../settings.js";
import { startWebFrontEnd, type WebFrontEnd, type WebSettingsSurface } from "./server.js";

let frontEnd: WebFrontEnd | null = null;

function memorySettings(): WebSettingsSurface {
  let snapshot: SettingsSnapshot = {
    config: defaultConfig(),
    editableConfig: { ...defaultConfig() },
    revision: "initial",
  };
  return {
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

/** The declaration block (text between `{` and `}`) of a single CSS rule. */
function styleDeclarations(pageMarkup: string, selector: string): string {
  const ruleStart = `    ${selector} {`;
  const startIndex = pageMarkup.indexOf(ruleStart);
  if (startIndex === -1) throw new Error(`web page has no style rule for ${selector}`);
  const declarationsStart = startIndex + ruleStart.length;
  const endIndex = pageMarkup.indexOf("}", declarationsStart);
  if (endIndex === -1) throw new Error(`web page style rule for ${selector} is not closed`);
  return pageMarkup.slice(declarationsStart, endIndex);
}

async function servedPage(): Promise<string> {
  frontEnd = await startWebFrontEnd({
    log: new EventLog("unused", false),
    boardName: "board.md",
    targetBranch: "main",
    integrationMode: "auto",
    settings: memorySettings(),
  });
  return await (await fetch(frontEnd.url)).text();
}

afterEach(async () => {
  await frontEnd?.close();
  frontEnd = null;
});

describe("kanban view fills the window (web-kanban-board-layout QA)", () => {
  it("AC1/AC2: the horizontal scroll lives on the document, not the board", async () => {
    const page = await servedPage();
    const body = styleDeclarations(page, "body");
    const kanban = styleDeclarations(page, ".kanban");

    // Horizontal overflow on body propagates to the viewport, so the scrollbar
    // is the window's own: full-width, pinned to the window bottom, and shared
    // with the vertical page scroll (it does not move when the page scrolls).
    expect(body).toContain("overflow-x: auto");
    // No page inset: the board and its scrollbar reach both window edges.
    expect(body).toContain("margin: 0");
    // The board must NOT own the horizontal scroll — that was the old inset,
    // column-anchored scrollbar this ticket removes.
    expect(kanban).not.toContain("overflow");
    expect(kanban).not.toMatch(/padding/);
  });

  it("AC3: columns have no fill or box border and are split by one line; cards keep their look", async () => {
    const page = await servedPage();
    const column = styleDeclarations(page, ".column");
    const separator = styleDeclarations(page, ".column + .column");
    const card = styleDeclarations(page, ".card");

    // A column is no longer "a card full of cards": no shaded box, no border.
    expect(column).not.toMatch(/background/);
    expect(column).not.toMatch(/border/);
    // Exactly one vertical line, and only between adjacent columns (the
    // adjacent-sibling selector leaves the first column with no left edge).
    expect(separator).toMatch(/border-left:\s*1px solid/);
    // The cards themselves are untouched — still bordered, filled boxes.
    expect(card).toMatch(/border:/);
    expect(card).toMatch(/background:/);
  });

  it("AC4: main is a full-height flex column whose board is the stretching remainder", async () => {
    const page = await servedPage();
    const main = styleDeclarations(page, "main");
    const kanban = styleDeclarations(page, ".kanban");

    // main spans at least the window and stacks header/pause/board vertically.
    expect(main).toContain("display: flex");
    expect(main).toContain("flex-direction: column");
    expect(main).toContain("min-height: 100vh");
    // The board takes the leftover height and stretches its columns into it, so
    // short columns (and the line between them) reach the window bottom.
    expect(kanban).toContain("flex: 1");
    expect(kanban).toContain("align-items: stretch");
    // No reintroduced page inset that would leave a gap at the window edges.
    expect(main).not.toContain("width: calc");
    expect(main).not.toMatch(/padding/);
  });

  it("AC5: no column scrolls on its own, so tall content scrolls the whole page", async () => {
    const page = await servedPage();
    const column = styleDeclarations(page, ".column");
    const kanban = styleDeclarations(page, ".kanban");

    // A per-column overflow would let one column scroll internally; the ticket
    // requires the page to grow and the viewport to scroll instead.
    expect(column).not.toMatch(/overflow/);
    expect(column).not.toMatch(/max-height/);
    expect(kanban).not.toMatch(/overflow/);
  });

  it("AC6: header, pause banner, settings entry point and panel, and the board container remain", async () => {
    const page = await servedPage();
    expect(page).toContain('class="brand"');
    expect(page).toContain('id="pause"');
    expect(page).toContain('id="settings-open"');
    expect(page).toContain('id="settings-panel"');
    expect(page).toContain('id="kanban"');
  });
});
