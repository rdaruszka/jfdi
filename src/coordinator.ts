import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Board, type Card, ensureColumns, findColumn, parseBoard } from "./board.js";
import { moveCardSafe } from "./card-moves.js";
import { mergedTicketIds } from "./events.js";
import { branchExists, isAncestor, revParse, ticketBranch } from "./git.js";
import { IntegrationQueue, integrateTicket } from "./integrate.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runPipeline, worktreesDir } from "./pipeline.js";
import { loadReport, recordMergeReady, recordObservations, saveReport } from "./report.js";
import { ensureJfdiGitignore } from "./scaffold.js";
import { resolveTicket, type Ticket } from "./tickets.js";
import { fileExists, readIfExists } from "./util/fsx.js";
import { ticketIdFromCard } from "./util/ids.js";

/** Name of the column holding this ticket's card, or null if the board has none. */
function columnOfTicket(board: Board, ticketId: string): string | null {
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (ticketIdFromCard(card.text) === ticketId) return column.name;
    }
  }
  return null;
}

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
    await this.context.log.followFromEnd();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
    this.pollTimer.unref();

    await this.sweepCrashOrphans();
    await this.scan();
  }

  /**
   * A card sitting in the in-progress column at startup was left there by a
   * coordinator that died mid-run: nothing is driving it, and no later scan
   * would ever look at that column. Move it to Blocked so the human sees it —
   * the branch keeps its partial work, and a re-dispatch resumes from it.
   */
  private async sweepCrashOrphans(): Promise<void> {
    // start() runs once on a fresh instance; anything in-progress predates us.
    if (this.active.size > 0)
      throw new Error("coordinator started with active pipelines — start() must run once");
    const columns = this.context.config.board.columns;
    const content = await readIfExists(this.boardPath);
    if (content === null) return;
    for (const card of findColumn(parseBoard(content), columns.inProgress)?.cards ?? []) {
      await moveCardSafe(this.context, card, columns.inProgress, columns.blocked, false);
      this.context.log.emit("blocked", ticketIdFromCard(card.text), {
        reason: "orphaned by a coordinator restart — no run was active",
      });
    }
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

  /** One tick: the board may have changed, and so may the shared event stream. */
  private async poll(): Promise<void> {
    await this.pollBoardMtime();
    await this.pollForeignEvents();
  }

  private async pollBoardMtime(): Promise<void> {
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

  /**
   * Another process writing to events.jsonl — `jfdi merge` approving a ticket
   * from a second terminal — is how a running coordinator learns of a merge it
   * did not perform. Folding those events in updates every renderer over this
   * log, and the rescan lets the sweep close the card they left behind.
   */
  private async pollForeignEvents(): Promise<void> {
    try {
      const foreign = await this.context.log.pullForeignEvents();
      if (foreign.length > 0) this.requestScan();
    } catch (error) {
      this.context.log.emit("error", undefined, {
        message: `could not read the event stream: ${(error as Error).message}`,
      });
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
    await this.closeMergedCards(board);
    this.acknowledgeApprovals(board);
    this.dispatchReadyCards(board);
  }

  /**
   * Close Ready-to-Merge cards whose work already landed, without merging
   * again. The obvious evidence is perishable — branch deletion is the normal
   * end of a merge, both when `jfdi merge` does it and when a human tidies up
   * after merging by hand — so treating a missing branch as "no evidence"
   * strands the card forever. Three shapes are accepted, in cost order:
   * the branch still exists and is contained in the target; a `merged` event
   * is on record; or the commit the reviews signed off on is in the target.
   */
  private async closeMergedCards(board: Board): Promise<void> {
    const columns = this.context.config.board.columns;
    const cards = findColumn(board, columns.readyToMerge)?.cards ?? [];
    // Read the event stream at most once per scan, and only if a branch is missing.
    let mergedIds: Set<string> | null = null;
    for (const card of cards) {
      const id = ticketIdFromCard(card.text);
      if (this.active.has(id)) continue;
      const branch = ticketBranch(id);
      let hasMerged: boolean;
      if (await branchExists(this.context.repoRoot, branch)) {
        hasMerged = await this.isInTarget(branch);
      } else {
        if (mergedIds === null) mergedIds = await mergedTicketIds(this.context.stateDir);
        hasMerged = mergedIds.has(id) || (await this.isSignedOffCommitInTarget(id));
      }
      if (!hasMerged) continue;
      await moveCardSafe(this.context, card, columns.readyToMerge, columns.done, true);
      this.context.log.emit("merged", id, { note: "merged outside the pipeline — card closed" });
    }
  }

  /**
   * Whether the commit a run's reviews signed off on is already in the target.
   * This is the evidence a hand-merge leaves once the branch is gone: nothing
   * records the merge, but `report.json` still names the tip, and a plain
   * `git merge` carries that very commit into the target. An integration that
   * rebased first rewrites the sha instead — that case is the `merged` event's,
   * which only our own integration writes. A sha git can no longer resolve
   * (the branch was deleted unmerged) is not contained in anything.
   */
  private async isSignedOffCommitInTarget(ticketId: string): Promise<boolean> {
    const report = await loadReport(this.context.stateDir, ticketId);
    if (report === null) return false;
    return this.isInTarget(report.commit);
  }

  private isInTarget(commitish: string): Promise<boolean> {
    return isAncestor(
      this.context.repoRoot,
      commitish,
      this.context.config.integration.target_branch,
    );
  }

  /**
   * A card dragged out of Ready to Merge is the human answering the approval
   * question, and the answer has to reach derived state or the ticket sits in
   * `merge-ready` forever while the board says otherwise. Only tickets this
   * process knows to be waiting are considered; the begin column is skipped
   * because that is the approval path, and dispatch speaks for it.
   */
  private acknowledgeApprovals(board: Board): void {
    const columns = this.context.config.board.columns;
    const waiting = new Set(
      (findColumn(board, columns.readyToMerge)?.cards ?? []).map((card) =>
        ticketIdFromCard(card.text),
      ),
    );
    for (const ticket of Object.values(this.context.log.snapshot().tickets)) {
      if (ticket.status !== "merge-ready") continue;
      if (waiting.has(ticket.id) || this.active.has(ticket.id)) continue;
      const column = columnOfTicket(board, ticket.id);
      if (column === columns.begin || column === columns.inProgress) continue;
      if (column === columns.blocked) {
        this.context.log.emit("blocked", ticket.id, {
          reason: `moved to "${columns.blocked}" on the board`,
        });
        continue;
      }
      this.context.log.emit("done", ticket.id, {
        note: column === null ? "card removed from the board" : `card moved to "${column}"`,
      });
    }
  }

  /** Dispatch from the begin column, top first, respecting max_concurrent. */
  private dispatchReadyCards(board: Board): void {
    const columns = this.context.config.board.columns;
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
      await moveCardSafe(this.context, card, columns.begin, columns.inProgress, false);

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
        await moveCardSafe(this.context, card, columns.inProgress, columns.blocked, false);
        return;
      }
      if (outcome.status === "failed") {
        this.context.log.emit("failed", id, { reason: outcome.reason });
        await moveCardSafe(this.context, card, columns.inProgress, columns.blocked, false);
        return;
      }

      await saveReport(this.context.stateDir, id, outcome.report);
      await recordObservations(this.context, id, outcome.report.observations);
      if (this.context.config.integration.mode === "on-approval") {
        const notePath = ticket.notePath ?? path.join(ticketsDir, `${ticket.id}.md`);
        await recordMergeReady(this.context, id, notePath, outcome.report);
        await moveCardSafe(this.context, card, columns.inProgress, columns.readyToMerge, false);
        return;
      }
      await this.integrate(card, ticket, outcome.report);
    } catch (error) {
      this.context.log.emit("failed", id, { reason: (error as Error).message });
      await moveCardSafe(this.context, card, columns.inProgress, columns.blocked, false).catch(
        () => {
          // Best-effort: the failure above is already logged; the board move is advisory.
        },
      );
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
      await moveCardSafe(this.context, card, columns.inProgress, columns.blocked, false);
      return;
    }
    await moveCardSafe(this.context, card, columns.inProgress, columns.done, true);
  }
}
