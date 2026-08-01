import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findColumn, parseBoard } from "./board.js";
import { loadConfig } from "./config.js";
import { EventLog } from "./events.js";
import { createProjectFixture } from "./fixture-project.js";
import { runGate } from "./gate.js";
import { git } from "./git.js";
import { FakeHarness } from "./harness/fake.js";
import { integrateTicket } from "./integrate.js";
import { type PipelineContext, runPipeline } from "./pipeline.js";
import { commitFile, stageOf, writeVerdict } from "./test-helpers.js";
import { resolveTicket } from "./tickets.js";

const TEMPLATE = fileURLToPath(new URL("../fixtures/half-app", import.meta.url));
const BACKLOG_SIZE = 7;

let root: string;

beforeEach(async () => {
  // Outside any parent git repo — the self-hosting hazard from CLAUDE.md.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-halfapp-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function board(repo: string) {
  return parseBoard(await fs.readFile(path.join(repo, ".jfdi", "board.md"), "utf8"));
}

describe("createProjectFixture", () => {
  it("mints a clean repo with staged history and all cards promoted", async () => {
    const fx = await createProjectFixture(TEMPLATE, path.join(root, "repo"));

    const subjects = (await git(fx.repo, "log", "--format=%s")).split("\n");
    expect(subjects).toHaveLength(3);
    expect(subjects.at(-1)).toBe("chore: project tooling");
    expect(await git(fx.repo, "status", "--porcelain")).toBe("");
    expect(await git(fx.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    const b = await board(fx.repo);
    expect(findColumn(b, "Ready")?.cards).toHaveLength(BACKLOG_SIZE);
    expect(findColumn(b, "Backlog")?.cards).toHaveLength(0);
    expect(fx.readyCards).toHaveLength(BACKLOG_SIZE);

    // Prompts were seeded pre-commit, so the copy versions the canonical set;
    // board and tickets exist on disk but stay out of product history.
    const prompts = await fs.readdir(path.join(fx.repo, ".jfdi", "prompts"));
    expect(prompts).toContain("implementation.md");
    const tracked = (await git(fx.repo, "ls-files", ".jfdi")).split("\n");
    expect(tracked).toContain(".jfdi/config.json");
    expect(tracked).toContain(".jfdi/prompts/implementation.md");
    expect(tracked).not.toContain(".jfdi/board.md");
    expect(tracked.some((f) => f.startsWith(".jfdi/tickets/"))).toBe(false);

    // Working artifacts from the template checkout never leak into copies.
    await expect(fs.access(path.join(fx.repo, "node_modules"))).rejects.toThrow();
    await expect(fs.access(path.join(fx.repo, "dist"))).rejects.toThrow();
  });

  it("promotes cards by position, wikilink id, or substring", async () => {
    const fx = await createProjectFixture(TEMPLATE, path.join(root, "repo"), {
      ready: ["filter-by-category", "7"],
    });
    expect(fx.readyCards).toHaveLength(2);

    const b = await board(fx.repo);
    const ready = findColumn(b, "Ready")?.cards ?? [];
    expect(ready.map((c) => c.text)).toEqual([
      "Add a category filter to penny list [[filter-by-category]]",
      "Add a --version flag that prints the version from package.json",
    ]);
    expect(findColumn(b, "Backlog")?.cards).toHaveLength(BACKLOG_SIZE - 2);
  });

  it("leaves everything in Backlog with ready: none, and rejects bad selectors", async () => {
    const fx = await createProjectFixture(TEMPLATE, path.join(root, "a"), { ready: "none" });
    expect(fx.readyCards).toHaveLength(0);
    expect(findColumn(await board(fx.repo), "Backlog")?.cards).toHaveLength(BACKLOG_SIZE);

    await expect(
      createProjectFixture(TEMPLATE, path.join(root, "b"), { ready: ["no-such-ticket"] }),
    ).rejects.toThrow(/no Backlog cards matched/);
  });

  it("resolves a promoted card to its ticket note spec", async () => {
    const fx = await createProjectFixture(TEMPLATE, path.join(root, "repo"), {
      ready: ["filter-by-category"],
    });
    const card = findColumn(await board(fx.repo), "Ready")?.cards[0];
    const ticket = await resolveTicket(card?.text ?? "", path.join(fx.repo, ".jfdi", "tickets"));
    expect(ticket.id).toBe("filter-by-category");
    expect(ticket.spec).toContain("case-insensitive");
    expect(ticket.notePath).toBe(path.join(fx.repo, ".jfdi", "tickets", "filter-by-category.md"));
  });
});

describe("half-app end-to-end (fake harness)", () => {
  it("runs a promoted ticket through pipeline and integration onto main", async () => {
    const fx = await createProjectFixture(TEMPLATE, path.join(root, "repo"), {
      ready: ["filter-by-category"],
    });
    const jfdiDir = path.join(fx.repo, ".jfdi");
    // The real gate needs node_modules per worktree; substitute a cheap real
    // command — gate mechanics are covered by gate.test.ts and the env-gated
    // suite below covers the fixture's actual gate.
    const config = {
      ...(await loadConfig(fx.repo)),
      gate: [{ name: "smoke", cmd: "test -f src/commands/list.ts" }],
    };

    const harness = new FakeHarness(async (spec, opts) => {
      switch (stageOf(spec.prompt)) {
        case "implementation":
          expect(spec.prompt).toContain("case-insensitive");
          await commitFile(
            opts.cwd,
            "src/commands/list.ts.category-note",
            "pretend category filter\n",
            "feat: category filter on list",
          );
          await writeVerdict(spec.prompt, {
            status: "done",
            summary: "added --category to list",
            decisions: ["matched case-insensitively via toLowerCase"],
          });
          break;
        case "code-review":
          await writeVerdict(spec.prompt, { verdict: "pass" });
          break;
        case "qa":
          await writeVerdict(spec.prompt, { verdict: "pass", testsAdded: "category filter e2e" });
          break;
        default:
          throw new Error("unexpected stage");
      }
      return { ok: true, text: "" };
    });

    const ctx: PipelineContext = {
      repoRoot: fx.repo,
      jfdiDir,
      config,
      harness,
      log: new EventLog(jfdiDir, false),
    };
    const ticket = await resolveTicket(
      "Add a category filter to penny list [[filter-by-category]]",
      path.join(fx.repo, ".jfdi", "tickets"),
    );

    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    // Board and ticket notes are untracked (spec §2), so the run's churn to
    // them never dirties the target checkout — the merge lands directly.
    const merged = await integrateTicket(ctx, ticket, outcome.worktree, outcome.report);
    expect(merged, JSON.stringify(merged)).toEqual({ status: "merged" });

    const subjects = await git(fx.repo, "log", "--format=%s", "main");
    expect(subjects).toContain("feat: category filter on list");

    const note = await fs.readFile(
      path.join(fx.repo, ".jfdi", "tickets", "filter-by-category.md"),
      "utf8",
    );
    expect(note).toContain("## Decisions");
    expect(note).toContain("## Report");
    expect(note).toContain("Merged into `main`");
  });
});

// The fixture's real gate: pnpm install + build + test + lint in a fresh copy.
// Opt-in — it hits the network/pnpm store and takes a minute cold.
describe.runIf(process.env.JFDI_FIXTURE_E2E === "1")("half-app real gate", () => {
  it("baseline gate is green", { timeout: 600_000 }, async () => {
    const fx = await createProjectFixture(TEMPLATE, path.join(root, "repo"), { ready: "none" });
    const config = await loadConfig(fx.repo);
    const gate = await runGate(config.gate, fx.repo);
    expect(gate.results.map((r) => `${r.name}:${r.code}`)).toEqual(
      config.gate.map((g) => `${g.name}:0`),
    );
    expect(gate.ok).toBe(true);
  });
});
