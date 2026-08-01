import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Card, ensureColumns, findColumn, moveCard, parseBoard } from "./board.js";
import { branchExists, isAncestor, ticketBranch } from "./git.js";
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

/**
 * Multi-ticket mode: watches the board, dispatches cards from the begin column
 * (top first, up to max_concurrent), owns the serialized integration queue,
 * and moves cards between columns as tickets progress.
 */
export class Coordinator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly integrations = new IntegrationQueue();
  private readonly pollMs: number;
  private stopped = false;
  private scanning = false;
  private rescanWanted = false;
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastMtime = 0;
  readonly sessions = new Set<{ kill(): void }>();

  constructor(
    private readonly ctx: PipelineContext,
    opts: CoordinatorOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 2000;
    ctx.sessions = this.sessions;
  }

  private get boardPath(): string {
    return path.join(this.ctx.repoRoot, this.ctx.config.board.path);
  }

  /** Set up board + watchers and run the initial scan. Resolves once watching. */
  async start(): Promise<void> {
    await ensureJfdiGitignore(this.ctx.jfdiDir);
    const cols = this.ctx.config.board.columns;
    if (!(await fileExists(this.boardPath)))
      throw new Error(
        `board not found at ${this.ctx.config.board.path} — run \`jfdi init\` or create it first`,
      );
    // The coordinator manages its own well-known columns, created if absent.
    // Inbox is agent-proposal-only: cards land there via recordObservations and
    // are never dispatched — only a human moves them out.
    await ensureColumns(this.boardPath, [cols.blocked, cols.readyToMerge, cols.inbox]);

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
    this.stopped = true;
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
      if (stat.mtimeMs !== this.lastMtime) {
        this.lastMtime = stat.mtimeMs;
        this.requestScan();
      }
    } catch {
      // board temporarily missing (editor save); next poll catches it
    }
  }

  /** Coalesce scan requests — only one scan runs at a time. */
  requestScan(): void {
    if (this.stopped) return;
    if (this.scanning) {
      this.rescanWanted = true;
      return;
    }
    void this.scan();
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      do {
        this.rescanWanted = false;
        await this.scanOnce();
      } while (this.rescanWanted && !this.stopped);
    } catch (err) {
      this.ctx.log.emit("error", undefined, { message: (err as Error).message });
    } finally {
      this.scanning = false;
    }
  }

  private async scanOnce(): Promise<void> {
    const content = await readIfExists(this.boardPath);
    if (content === null) return;
    const board = parseBoard(content);
    const cols = this.ctx.config.board.columns;

    // Hand-merged Ready-to-Merge cards: close without double-merging.
    for (const card of findColumn(board, cols.readyToMerge)?.cards ?? []) {
      const id = ticketIdFromCard(card.text);
      if (this.active.has(id)) continue;
      const branch = ticketBranch(id);
      if (
        (await branchExists(this.ctx.repoRoot, branch)) &&
        (await isAncestor(this.ctx.repoRoot, branch, this.ctx.config.integration.target_branch))
      ) {
        await this.moveCardSafe(card, cols.readyToMerge, cols.done, true);
        this.ctx.log.emit("merged", id, { note: "merged by hand — card closed" });
      }
    }

    // Dispatch from the begin column, top first, respecting max_concurrent.
    for (const card of findColumn(board, cols.begin)?.cards ?? []) {
      if (this.active.size >= this.ctx.config.max_concurrent) break;
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
    const cols = this.ctx.config.board.columns;
    try {
      const ticketsDir = path.join(this.ctx.repoRoot, this.ctx.config.ticketsDir);
      const ticket = await resolveTicket(card.text, ticketsDir);
      await this.moveCardSafe(card, cols.begin, cols.inProgress, false);

      // A begin-column card whose pipeline already passed is an approval:
      // integrate the existing branch instead of rebuilding.
      const savedReport = await loadReport(this.ctx.stateDir, id);
      const branch = ticketBranch(id);
      if (savedReport && (await branchExists(this.ctx.repoRoot, branch))) {
        await this.integrate(card, ticket, savedReport);
        return;
      }

      const outcome = await runPipeline(this.ctx, ticket);
      if (outcome.status === "blocked") {
        await this.moveCardSafe(card, cols.inProgress, cols.blocked, false);
        return;
      }
      if (outcome.status === "failed") {
        this.ctx.log.emit("failed", id, { reason: outcome.reason });
        await this.moveCardSafe(card, cols.inProgress, cols.blocked, false);
        return;
      }

      await saveReport(this.ctx.stateDir, id, outcome.report);
      await recordObservations(this.ctx, id, outcome.report.observations);
      if (this.ctx.config.integration.mode === "on-approval") {
        const notePath = ticket.notePath ?? path.join(ticketsDir, `${ticket.id}.md`);
        await recordMergeReady(this.ctx, id, notePath, outcome.report);
        await this.moveCardSafe(card, cols.inProgress, cols.readyToMerge, false);
        return;
      }
      await this.integrate(card, ticket, outcome.report);
    } catch (err) {
      this.ctx.log.emit("failed", id, { reason: (err as Error).message });
      await this.moveCardSafe(card, cols.inProgress, cols.blocked, false).catch(() => {
        // Best-effort: the failure above is already logged; the board move is advisory.
      });
    }
  }

  /** Integration is the global critical section: strictly one at a time. */
  private async integrate(card: Card, ticket: Ticket, report: RunReport): Promise<void> {
    const cols = this.ctx.config.board.columns;
    this.ctx.log.emit("merge_queued", ticket.id);
    const outcome = await this.integrations.enqueue(() =>
      integrateTicket(
        this.ctx,
        ticket,
        {
          path: path.join(worktreesDir(this.ctx.jfdiDir), ticket.id),
          branch: ticketBranch(ticket.id),
        },
        report,
      ),
    );
    if (outcome.status === "blocked") {
      await this.moveCardSafe(card, cols.inProgress, cols.blocked, false);
      return;
    }
    await this.moveCardSafe(card, cols.inProgress, cols.done, true);
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
    checkOff: boolean,
  ): Promise<void> {
    const rewrite = checkOff ? { rewriteLine: (l: string) => l.replace("- [ ]", "- [x]") } : {};
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
        this.ctx.log.emit("error", ticketIdFromCard(card.text), {
          message: `could not move card to "${to}" — leaving board as-is`,
        });
        return;
      }
    }
    this.ctx.log.emit("card_moved", ticketIdFromCard(card.text), { from, to });
  }
}
