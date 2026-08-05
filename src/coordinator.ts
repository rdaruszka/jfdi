import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type BlockingNode,
  blockedByCycles,
  type UnresolvedBlockers,
  unresolvedBlockers,
} from "./blocking.js";
import {
  type Board,
  type Card,
  columnOfTicket,
  ensureColumns,
  findColumn,
  parseBoard,
} from "./board.js";
import { boardPath, moveCardSafe } from "./cards.js";
import { type IntegrationRecord, integrationRecords } from "./events.js";
import { branchExists, isAncestor, revParse, ticketBranch } from "./git.js";
import { IntegrationQueue, integrateTicket } from "./integrate.js";
import type { PipelineContext } from "./pipeline.js";
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
  /**
   * Begin-column tickets currently held back for unresolved blockers, so a skip
   * announces once per episode rather than once per scan. Bounded to the begin
   * column: pruned each scan as cards unblock or move away.
   */
  private readonly blockedByEpisodes = new Set<string>();
  /**
   * Signatures of blocked-by cycles already reported, so each deadlock errors
   * once. Pruned each scan to the cycles the board still holds, so an untied and
   * re-formed cycle reports again.
   */
  private readonly reportedCycles = new Set<string>();
  private readonly integrations = new IntegrationQueue();
  private readonly pollMs: number;
  private isStopped = false;
  private isScanning = false;
  private isRescanWanted = false;
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastMtimeMs = 0;
  private readonly unsubscribeFromPause: () => void;
  readonly sessions = new Set<{ kill(): void }>();

  constructor(
    private readonly context: PipelineContext,
    options: CoordinatorOptions = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
    context.sessions = this.sessions;
    // A pause suspends dispatch and a resume must restart it, and neither
    // touches the board — so neither would ever reach a scan on its own.
    this.unsubscribeFromPause = context.pause.subscribe(() => this.requestScan());
  }

  private get boardPath(): string {
    return boardPath(this.context);
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

    await this.scan();
  }

  /** Stop watching, kill live sessions. In-flight pipelines settle in the background. */
  stop(): void {
    this.isStopped = true;
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubscribeFromPause();
    this.context.pause.stop();
    for (const session of this.sessions) session.kill();
  }

  /** Wait for all active pipelines and queued integrations (tests, graceful drain). */
  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
    }
    await this.integrations.idle();
  }

  /**
   * Request a scan and resolve once it — and any rescan it chains — has fully
   * run. The deterministic seam tests drive dispatch through, in place of racing
   * a fire-and-forget `requestScan` against a sleep. Production wakes scans
   * through `requestScan` and never needs to await one. Terminates because every
   * scan clears `isScanning` in its `finally`, and each pass yields the loop.
   */
  async settleScan(): Promise<void> {
    this.requestScan();
    while (this.isScanning) {
      await new Promise((resolve) => setImmediate(resolve));
    }
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
    // Paused means the provider under the harness is down: a new dispatch
    // would spawn straight into the same wall. The resume triggers a rescan.
    if (!this.context.pause.isPaused()) await this.dispatchReadyCards(board);
  }

  /**
   * Close Ready-to-Merge cards whose work already landed, without merging
   * again. The obvious evidence is perishable — branch deletion is the normal
   * end of a merge, both when `jfdi merge` does it and when a human tidies up
   * after merging by hand — so treating a missing branch as "no evidence"
   * strands the card forever. Three shapes are accepted, in cost order:
   * the branch still exists and is contained in the target; a `merged` event
   * is on record; or the commit the reviews signed off on is in the target.
   * A ticket whose stream shows an integration still in flight is skipped —
   * the merging process closes its own card, and only the sweep's restraint
   * keeps the shared stream from carrying two `merged` lines for one merge.
   */
  private async closeMergedCards(board: Board): Promise<void> {
    const columns = this.context.config.board.columns;
    const cards = findColumn(board, columns.readyToMerge)?.cards ?? [];
    // Read the event stream at most once per scan, and only once a card needs it.
    let records: Map<string, IntegrationRecord> | null = null;
    for (const card of cards) {
      const id = ticketIdFromCard(card.text);
      if (this.active.has(id)) continue;
      if (records === null) records = await integrationRecords(this.context.stateDir);
      const record = records.get(id);
      // Mid-integration in another process (`jfdi merge` in a second
      // terminal): between its landing commit and its own card move, git
      // evidence says merged while the card still sits here. That process
      // finishes its own story; sweeping now would tell it twice.
      if (record?.phase === "in-flight") continue;
      const branch = ticketBranch(id);
      let hasMerged: boolean;
      if (await branchExists(this.context.repoRoot, branch)) {
        // A live branch answers for itself: a recorded merge may be an earlier
        // run's, and a re-dispatched ticket's fresh branch must not close on it.
        hasMerged = await this.isInTarget(branch);
      } else {
        hasMerged = record?.phase === "merged" || (await this.isSignedOffCommitInTarget(id));
      }
      if (!hasMerged) continue;
      // A merge already narrated on the stream is folded into this instance's
      // state, not re-emitted; only a merge nothing recorded — a human's hand
      // merge — gets the sweep's own `merged` line. Status first, then the
      // card move, so the move's persisted snapshot already reads done.
      if (record?.phase === "merged") {
        this.context.log.foldRecorded(record.event);
      } else {
        this.context.log.emit("merged", id, { note: "merged outside the pipeline — card closed" });
      }
      await moveCardSafe(this.context, card, columns.readyToMerge, columns.done, true);
    }
  }

  /**
   * Whether the commit a run's reviews signed off on is already in the target.
   * This is the evidence a hand-merge leaves once the branch is gone: nothing
   * records the merge, but `report.json` still names the tip, and any merge —
   * a human's or our own — carries that very commit into the target as a
   * parent. Our own integrations also write the `merged` event, so this check
   * only has to catch the ones that happened outside the tool. A sha git can no
   * longer resolve (the branch was deleted unmerged) is not contained in
   * anything.
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

  /**
   * Dispatch, top first, respecting max_concurrent. In-progress cards go
   * first: a card in that column with nothing driving it is work already part
   * done — a coordinator died, or one was stopped mid-run — and continuing it
   * is what the resume machinery is for. Begin-column cards follow.
   */
  private async dispatchReadyCards(board: Board): Promise<void> {
    const columns = this.context.config.board.columns;
    const stranded = (findColumn(board, columns.inProgress)?.cards ?? [])
      .filter((card) => !this.hasRunHere(ticketIdFromCard(card.text)))
      .map((card) => ({ card, isAlreadyInProgress: true }));
    const ready = (await this.dispatchableBeginCards(board)).map((card) => ({
      card,
      isAlreadyInProgress: false,
    }));
    for (const { card, isAlreadyInProgress } of [...stranded, ...ready]) {
      if (this.active.size >= this.context.config.max_concurrent) break;
      const id = ticketIdFromCard(card.text);
      if (this.active.has(id)) continue;
      const job = this.dispatch(card, id, isAlreadyInProgress).finally(() => {
        this.active.delete(id);
        this.requestScan();
      });
      this.active.set(id, job);
    }
  }

  /**
   * The begin-column cards clear to dispatch: those whose ticket has no
   * unresolved blocked-by link. A card blocked by a ticket not yet in the done
   * column is left exactly where the human put it — skipping is not an
   * escalation and moves no card — and is re-checked every scan; it dispatches
   * on the first scan after the last blocker's card reaches done. The skip, the
   * unblock, and any deadlock each announce once per episode, not per scan.
   */
  private async dispatchableBeginCards(board: Board): Promise<Card[]> {
    const columns = this.context.config.board.columns;
    const ticketsDir = path.join(this.context.repoRoot, this.context.config.ticketsDir);
    // One shared policy for the whole gate: `unresolvedBlockers` deduplicates
    // links and computes the missing set, so dispatch, the event payload, and
    // the cycle nodes all read the same answer as `jfdi run`.
    const nodes: Array<{ card: Card; id: string; blockers: UnresolvedBlockers }> = [];
    for (const card of findColumn(board, columns.begin)?.cards ?? []) {
      const ticket = await resolveTicket(card.text, ticketsDir);
      nodes.push({
        card,
        id: ticketIdFromCard(card.text),
        blockers: unresolvedBlockers(ticket.links, board, columns.done),
      });
    }
    this.reportBlockedByCycles(
      nodes.map((node) => ({ id: node.id, blockedBy: node.blockers.ids })),
    );

    const dispatchable: Card[] = [];
    const blockedNow = new Set<string>();
    for (const node of nodes) {
      if (node.blockers.ids.length === 0) {
        if (this.blockedByEpisodes.delete(node.id)) this.context.log.emit("unblocked", node.id);
        dispatchable.push(node.card);
        continue;
      }
      blockedNow.add(node.id);
      if (!this.blockedByEpisodes.has(node.id)) {
        this.blockedByEpisodes.add(node.id);
        this.context.log.emit("blocked_by", node.id, {
          blockers: node.blockers.ids,
          missing: node.blockers.missing,
        });
      }
    }
    // A card that left the begin column while blocked ends its episode silently:
    // the human moved it, it did not unblock. This also keeps the set bounded to
    // the begin column.
    for (const id of [...this.blockedByEpisodes])
      if (!blockedNow.has(id)) this.blockedByEpisodes.delete(id);
    return dispatchable;
  }

  /**
   * A blocked-by cycle among begin-column cards is a deadlock: every member
   * waits on another that will never reach done, so none dispatch. The tool
   * does not untie it — it names it once, as an error for the human, and forgets
   * a cycle the board no longer holds so a re-formed one reports again.
   */
  private reportBlockedByCycles(nodes: BlockingNode[]): void {
    const live = new Set<string>();
    for (const cycle of blockedByCycles(nodes)) {
      const signature = cycle.join(",");
      live.add(signature);
      if (this.reportedCycles.has(signature)) continue;
      this.reportedCycles.add(signature);
      this.context.log.emit("error", undefined, {
        message: `blocked-by cycle among begin-column tickets: ${cycle.join(", ")} — none will dispatch until it is untied`,
        cycle,
      });
    }
    for (const signature of [...this.reportedCycles])
      if (!live.has(signature)) this.reportedCycles.delete(signature);
  }

  /**
   * Whether this process has already run this ticket. A scan decides from a
   * board it read before awaiting git, so a run that finished in the meantime
   * can still appear in the in-progress column with `active` already cleared —
   * and dispatching from that stale line would run the ticket twice. Nothing
   * this coordinator dispatched ever needs dispatching again: a stranded card
   * is by definition one an earlier process left, and this log starts empty.
   * A `waiting` ticket is the exception the log alone would get wrong — a
   * blocked-by skip records ticket state without ever running the ticket — so a
   * stranded card carrying that id is still a genuine resume.
   */
  private hasRunHere(ticketId: string): boolean {
    const ticket = this.context.log.snapshot().tickets[ticketId];
    return ticket !== undefined && ticket.status !== "waiting";
  }

  private async dispatch(card: Card, id: string, isAlreadyInProgress: boolean): Promise<void> {
    const columns = this.context.config.board.columns;
    try {
      const ticketsDir = path.join(this.context.repoRoot, this.context.config.ticketsDir);
      const ticket = await resolveTicket(card.text, ticketsDir);
      if (!isAlreadyInProgress)
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
        await this.integrate(card, ticket);
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
      await this.integrate(card, ticket);
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
  private async integrate(card: Card, ticket: Ticket): Promise<void> {
    const columns = this.context.config.board.columns;
    this.context.log.emit("merge_queued", ticket.id);
    const outcome = await this.integrations.enqueue(() =>
      integrateTicket(this.context, ticket, {
        path: path.join(worktreesDir(this.context.jfdiDir), ticket.id),
        branch: ticketBranch(ticket.id),
      }),
    );
    if (outcome.status === "blocked") {
      await moveCardSafe(this.context, card, columns.inProgress, columns.blocked, false);
      return;
    }
    await moveCardSafe(this.context, card, columns.inProgress, columns.done, true);
  }
}
