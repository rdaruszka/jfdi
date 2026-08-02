import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Card, ensureColumns, findColumn, moveCard, parseBoard } from "./board.js";
import { branchExists, isAncestor, revParse, ticketBranch } from "./git.js";
import { IntegrationQueue, integrateTicket } from "./integrate.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runPipeline, worktreesDir } from "./pipeline.js";
import { loadReport, recordMergeReady, recordObservations, saveReport } from "./report.js";
import { ensureJfdiGitignore } from "./scaffold.js";
import { resolveTicket, type Ticket } from "./tickets.js";
import { fileExists, readIfExists } from "./util/fsx.js";
import { ticketIdFromCard } from "./util/ids.js";

export interface CoordinatorOptions {
  /** Polling fallback interval for board changes (ms). */
  pollMs?: number;
}

/** How often the mtime poll runs when `fs.watch` misses (or is unavailable). */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Multi-ticket mode: watches the board, dispatches cards from the begin column
 * (top first, up to max_concurrent), owns the serialized integration queue,
 * and moves cards between columns as tickets progress.
 */
export class Coordinator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly integrations = new IntegrationQueue();
  private readonly pollMs: number;
  private isStopped = false;
  private isScanning = false;
  private isRescanWanted = false;
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastMtimeMs = 0;
  readonly sessions = new Set<{ kill(): void }>();

  constructor(
    private readonly context: PipelineContext,
    options: CoordinatorOptions = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
    context.sessions = this.sessions;
  }

  private get boardPath(): string {
    return path.join(this.context.repoRoot, this.context.config.board.path);
  }

  /** Set up board + watchers and run the initial scan. Resolves once watching. */
  async start(): Promise<void> {
    await ensureJfdiGitignore(this.context.jfdiDir);
    const columns = this.context.config.board.columns;
    if (!(await fileExists(this.boardPath)))
      throw new Error(
        `board not found at ${this.context.config.board.path} — run \`jfdi init\` or create it first`,
      );
    // The coordinator manages its own well-known columns, created if absent.
    // Inbox is agent-proposal-only: cards land there via recordObservations and
    // are never dispatched — only a human moves them out.
    await ensureColumns(this.boardPath, [columns.blocked, columns.readyToMerge, columns.inbox]);

    try {
      this.watcher = watch(this.boardPath, { persistent: false }, () => this.requestScan());
    } catch {
      // fs.watch unavailable — polling below covers it.
    }
    this.pollTimer = setInterval(() => {
      void this.pollMtime();
    }, this.pollMs);
    this.pollTimer.unref();

    await this.scan();
  }

  /** Stop watching, kill live sessions. In-flight pipelines settle in the background. */
  stop(): void {
    this.isStopped = true;
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const session of this.sessions) session.kill();
  }

  /** Wait for all active pipelines and queued integrations (tests, graceful drain). */
  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
    }
    await this.integrations.idle();
  }

  activeCount(): number {
    return this.active.size;
  }

  private async pollMtime(): Promise<void> {
    try {
      const stat = await fs.stat(this.boardPath);
      if (stat.mtimeMs !== this.lastMtimeMs) {
        this.lastMtimeMs = stat.mtimeMs;
        this.requestScan();
      }
    } catch {
      // board temporarily missing (editor save); next poll catches it
    }
  }

  /** Coalesce scan requests — only one scan runs at a time. */
  requestScan(): void {
    if (this.isStopped) return;
    if (this.isScanning) {
      this.isRescanWanted = true;
      return;
    }
    void this.scan();
  }

  private async scan(): Promise<void> {
    if (this.isStopped || this.isScanning) return;
    this.isScanning = true;
    try {
      do {
        this.isRescanWanted = false;
        await this.scanOnce();
      } while (this.isRescanWanted && !this.isStopped);
    } catch (error) {
      this.context.log.emit("error", undefined, { message: (error as Error).message });
    } finally {
      this.isScanning = false;
    }
  }

  private async scanOnce(): Promise<void> {
    const content = await readIfExists(this.boardPath);
    if (content === null) return;
    const board = parseBoard(content);
    const columns = this.context.config.board.columns;

    // Hand-merged Ready-to-Merge cards: close without double-merging.
    for (const card of findColumn(board, columns.readyToMerge)?.cards ?? []) {
      const id = ticketIdFromCard(card.text);
      if (this.active.has(id)) continue;
      const branch = ticketBranch(id);
      if (
        (await branchExists(this.context.repoRoot, branch)) &&
        (await isAncestor(
          this.context.repoRoot,
          branch,
          this.context.config.integration.target_branch,
        ))
      ) {
        await this.moveCardSafe(card, columns.readyToMerge, columns.done, true);
        this.context.log.emit("merged", id, { note: "merged by hand — card closed" });
      }
    }

    // Dispatch from the begin column, top first, respecting max_concurrent.
    for (const card of findColumn(board, columns.begin)?.cards ?? []) {
      if (this.active.size >= this.context.config.max_concurrent) break;
      const id = ticketIdFromCard(card.text);
      if (this.active.has(id)) continue;
      const job = this.dispatch(card, id).finally(() => {
        this.active.delete(id);
        this.requestScan();
      });
      this.active.set(id, job);
    }
  }

  private async dispatch(card: Card, id: string): Promise<void> {
    const columns = this.context.config.board.columns;
    try {
      const ticketsDir = path.join(this.context.repoRoot, this.context.config.ticketsDir);
      const ticket = await resolveTicket(card.text, ticketsDir);
      await this.moveCardSafe(card, columns.begin, columns.inProgress, false);

      // A begin-column card whose pipeline already passed is an approval:
      // integrate the existing branch instead of rebuilding. Sign-offs bind to
      // a commit, so the shortcut holds only while the branch still points at
      // the commit the report signed off on — if it moved, the report no
      // longer describes what would land, and the pipeline runs instead.
      const savedReport = await loadReport(this.context.stateDir, id);
      const branch = ticketBranch(id);
      if (
        savedReport &&
        (await branchExists(this.context.repoRoot, branch)) &&
        (await revParse(this.context.repoRoot, branch)) === savedReport.commit
      ) {
        await this.integrate(card, ticket, savedReport);
        return;
      }

      const outcome = await runPipeline(this.context, ticket);
      if (outcome.status === "blocked") {
        await this.moveCardSafe(card, columns.inProgress, columns.blocked, false);
        return;
      }
      if (outcome.status === "failed") {
        this.context.log.emit("failed", id, { reason: outcome.reason });
        await this.moveCardSafe(card, columns.inProgress, columns.blocked, false);
        return;
      }

      await saveReport(this.context.stateDir, id, outcome.report);
      await recordObservations(this.context, id, outcome.report.observations);
      if (this.context.config.integration.mode === "on-approval") {
        const notePath = ticket.notePath ?? path.join(ticketsDir, `${ticket.id}.md`);
        await recordMergeReady(this.context, id, notePath, outcome.report);
        await this.moveCardSafe(card, columns.inProgress, columns.readyToMerge, false);
        return;
      }
      await this.integrate(card, ticket, outcome.report);
    } catch (error) {
      this.context.log.emit("failed", id, { reason: (error as Error).message });
      await this.moveCardSafe(card, columns.inProgress, columns.blocked, false).catch(() => {
        // Best-effort: the failure above is already logged; the board move is advisory.
      });
    }
  }

  /** Integration is the global critical section: strictly one at a time. */
  private async integrate(card: Card, ticket: Ticket, report: RunReport): Promise<void> {
    const columns = this.context.config.board.columns;
    this.context.log.emit("merge_queued", ticket.id);
    const outcome = await this.integrations.enqueue(() =>
      integrateTicket(
        this.context,
        ticket,
        {
          path: path.join(worktreesDir(this.context.jfdiDir), ticket.id),
          branch: ticketBranch(ticket.id),
        },
        report,
      ),
    );
    if (outcome.status === "blocked") {
      await this.moveCardSafe(card, columns.inProgress, columns.blocked, false);
      return;
    }
    await this.moveCardSafe(card, columns.inProgress, columns.done, true);
  }

  /**
   * Move a card, tolerating a human having already moved it: if the raw line
   * isn't in the expected source column, find it wherever it is; if it's gone
   * entirely, log and continue (the board is the human's document).
   */
  private async moveCardSafe(
    card: Card,
    from: string,
    to: string,
    shouldCheckOff: boolean,
  ): Promise<void> {
    const rewrite = shouldCheckOff
      ? { rewriteLine: (l: string) => l.replace("- [ ]", "- [x]") }
      : {};
    try {
      await moveCard(this.boardPath, card.raw, from, to, rewrite);
    } catch {
      // Not in `from` — locate it.
      const content = await readIfExists(this.boardPath);
      if (content === null) return;
      const board = parseBoard(content);
      const actual = board.columns.find((c) => c.cards.some((k) => k.raw === card.raw));
      if (!actual || actual.name === to) return;
      try {
        await moveCard(this.boardPath, card.raw, actual.name, to, rewrite);
      } catch {
        this.context.log.emit("error", ticketIdFromCard(card.text), {
          message: `could not move card to "${to}" — leaving board as-is`,
        });
        return;
      }
    }
    this.context.log.emit("card_moved", ticketIdFromCard(card.text), { from, to });
  }
}
