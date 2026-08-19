import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { TICKET_FORMAT } from "./ticket-format.js";

/**
 * Acceptance for the ticket-format contract shipped into target projects at
 * init. Two guarantees the drift test and the conformance layout test do not
 * pin:
 *
 *  1. The shipped contract actually *covers* the topics the ticket mandates.
 *     The drift test only proves `src/ticket-format.ts` equals the doc; the
 *     conformance test only proves a file by that name is scaffolded. Neither
 *     would notice a future rewrite that silently dropped the JFDI-owned-section
 *     rule, the good/bad example pair, or the ready-for-work checklist — the
 *     very things this ticket exists to ship. These assertions lock the "the
 *     doc covers, at minimum" list from the ticket.
 *  2. `jfdi init --bare` scaffolds it byte-for-byte and leaves it *versioned* —
 *     not swept up by the `.jfdi/.gitignore` that hides worktrees, board and
 *     tickets. A stranger's clone must carry the contract.
 */
const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

describe("the shipped ticket-format contract covers the mandated topics", () => {
  // Each entry is one acceptance item from the ticket's "doc covers, at
  // minimum" list, checked by a stable, meaning-bearing phrase rather than
  // incidental wording so a genuine reword survives but a dropped topic fails.
  const mandated: Array<[string, RegExp]> = [
    ["frontmatter mode key JFDI reads", /mode: ask/],
    ["blocks and blocked-by as wikilink lists", /blocked-by[\s\S]*wikilink/i],
    [
      "everything else preserved but ignored",
      /preserves every\s+other frontmatter key but ignores it/i,
    ],
    ["Questions/Comments are JFDI-owned", /JFDI-owned/],
    ["those sections are append-only", /append-only/],
    ["never write into them", /never create, edit, or add prose/i],
    [
      "spec below them never reaches a stage prompt",
      /reach stage prompts as questions awaiting answers/i,
    ],
    [
      "description one to two short paragraphs",
      /one short plain-language\s+paragraph, or two at most/i,
    ],
    [
      "acceptance criteria are user-facing, not implementation",
      /observable, user-facing behavior/i,
    ],
    ["a good/bad example pair", /Good:[\s\S]*Bad:/],
    ["Technical context holds constraints, not solutions", /genuine constraints/i],
    ["one card per line", /exactly one card per line/i],
    [
      "wikilink resolves only against the tickets directory",
      /resolves only against the configured tickets\s+directory/i,
    ],
    ["filename = ticket id = branch name", /runs on branch\s*\n?\s*`jfdi\//i],
    [
      "begin column dispatches; only a human promotes",
      /Only a human\s+promotes a card into that column/i,
    ],
    [
      "drafts/proposals go to a non-role column",
      /drafts and directly requested ticket\s+proposals in a non-role column/i,
    ],
    ["trivial one-liners may stay bare cards", /trivial one-line task may be a bare card/i],
    ["ready-for-work checklist", /Ready-for-work checklist/],
    ["scoped to one pipeline run", /scoped to one pipeline run/i],
    ["criteria testable by someone who didn't write it", /did not write the ticket can test/i],
    ["bug tickets name a reproduction", /bug ticket names how to reproduce/i],
  ];

  for (const [topic, pattern] of mandated) {
    it(`covers: ${topic}`, () => {
      expect(TICKET_FORMAT, `ticket-format contract no longer covers: ${topic}`).toMatch(pattern);
    });
  }

  it("tells the reader to read it before creating or changing a card or ticket", () => {
    expect(TICKET_FORMAT).toMatch(/before creating or changing a JFDI card or ticket/i);
  });
});

describe("jfdi init --bare ships the ticket-format contract, versioned", () => {
  const sandboxRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      sandboxRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function initBareProject(): Promise<string> {
    // Scratch repo under the OS temp dir — never inside this worktree or any
    // parent repo (git and the agent CLIs walk up the tree).
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-ticket-format-"));
    sandboxRoots.push(created);
    const root = await fs.realpath(created);
    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await git(project, "init", "-b", "main");
    await git(project, "config", "user.email", "qa@jfdi.local");
    await git(project, "config", "user.name", "JFDI QA");
    await execFileAsync(process.execPath, [cliPath, "init", "--bare"], {
      cwd: project,
      // --bare never reaches an agent CLI, so no PATH stubs are needed; a
      // scratch JFDI_HOME still guards the real ~/.jfdi from any run state.
      env: { ...process.env, JFDI_HOME: path.join(root, "home") },
    });
    return project;
  }

  it("writes .jfdi/ticket-format.md byte-for-byte equal to the compiled contract", async () => {
    const project = await initBareProject();
    const onDisk = await fs.readFile(path.join(project, ".jfdi", "ticket-format.md"), "utf8");
    expect(onDisk).toBe(TICKET_FORMAT);
  });

  it("leaves the contract tracked by git, not swept into .jfdi/.gitignore", async () => {
    const project = await initBareProject();
    // check-ignore exits 0 only when the path IS ignored; a non-zero exit here
    // proves the contract stays versioned alongside config.json and prompts,
    // unlike board.md, tickets/ and worktrees/.
    await expect(git(project, "check-ignore", ".jfdi/ticket-format.md")).rejects.toThrow();
  });
});
