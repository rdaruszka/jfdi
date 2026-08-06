import { type Board, columnOfTicket } from "./board.js";
import type { TicketLink } from "./tickets.js";
import { slugify } from "./util/ids.js";

/** A ticket's blocked-by links that are not yet resolved, read off the board. */
export interface UnresolvedBlockers {
  /** Blocker ids not in the done column, in link order — the waiting-on set. */
  ids: string[];
  /** The subset whose id names no card anywhere on the board (dangling links). */
  missing: string[];
}

/**
 * The blockers of a ticket that are not yet done. A blocker is resolved only
 * when its card sits in the done column — the board is the human-visible truth,
 * and cards land there on merge. A blocked-by link whose target has no card at
 * all is unresolved too, surfaced as `missing` rather than passed silently.
 */
export function unresolvedBlockers(
  links: TicketLink[],
  board: Board,
  doneColumn: string,
): UnresolvedBlockers {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const link of links) {
    if (link.kind !== "blocked-by") continue;
    const blockerId = slugify(link.target);
    if (ids.includes(blockerId)) continue;
    const column = columnOfTicket(board, blockerId);
    if (column === doneColumn) continue;
    ids.push(blockerId);
    if (column === null) missing.push(blockerId);
  }
  return { ids, missing };
}

/** Human-readable blocker list for a message; dangling blockers are flagged. */
export function describeBlockers(blockers: UnresolvedBlockers): string {
  return blockers.ids
    .map((id) => (blockers.missing.includes(id) ? `${id} (no card on the board)` : id))
    .join(", ");
}

/** One begin-column ticket and the begin-column tickets it lists as blocked-by. */
export interface BlockingNode {
  id: string;
  blockedBy: string[];
}

/**
 * Blocked-by cycles among begin-column tickets: groups whose members
 * transitively block one another, so none can ever reach done and none will
 * dispatch. Only edges between begin-column tickets count — a blocker parked
 * elsewhere is not part of a live deadlock. Each group is a cycle's members
 * sorted, and the groups come sorted too, so a caller can dedupe on the
 * signature. (Reporting cycles of any size, not just the pairwise A↔B, is the
 * same mechanism; a 2-cycle is only its smallest shape.)
 */
export function blockedByCycles(nodes: BlockingNode[]): string[][] {
  const present = new Set(nodes.map((node) => node.id));
  const edges = new Map<string, string[]>();
  const selfBlocked = new Set<string>();
  for (const node of nodes) {
    const targets: string[] = [];
    for (const blocker of node.blockedBy) {
      if (!present.has(blocker)) continue;
      if (blocker === node.id) selfBlocked.add(node.id);
      targets.push(blocker);
    }
    edges.set(node.id, targets);
  }
  return new StronglyConnectedComponents(edges)
    .compute(nodes.map((node) => node.id))
    .filter((members) => members.length > 1 || members.some((member) => selfBlocked.has(member)))
    .map((members) => [...members].sort())
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

/**
 * A directed closed walk through every member of one blocked-by component.
 * `blockedByCycles` sorts members for a stable signature, so that order cannot
 * label arrows. This starts at the signature's first member, joins each
 * remaining member by a shortest in-component blocked-by path, then returns to
 * the start. A component may lack a simple cycle containing every member, but
 * strong connectivity guarantees this closed walk, and every rendered arrow
 * is a link that actually exists. The outer loop terminates because each path
 * reaches and removes its selected remaining member.
 */
export function blockedByLoop(cycle: string[], nodes: BlockingNode[]): string[] {
  const firstMember = cycle[0];
  if (firstMember === undefined)
    throw new Error("cannot render blocked-by loop with no cycle members");
  const cycleMembers = new Set(cycle);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  if (cycle.length === 1) {
    const node = nodesById.get(firstMember);
    if (!node?.blockedBy.includes(firstMember))
      throw new Error(
        `cannot render blocked-by loop for "${firstMember}": its self-link is missing — inspect its blocked-by links`,
      );
    return [firstMember, firstMember];
  }

  const remainingMembers = new Set(cycle.slice(1));
  const loop = [firstMember];
  let currentMember = firstMember;
  while (remainingMembers.size > 0) {
    const targetMember = cycle.find((member) => remainingMembers.has(member));
    if (targetMember === undefined)
      throw new Error("cannot render blocked-by loop: remaining member is absent from its cycle");
    const path = blockedByPath(currentMember, targetMember, cycleMembers, nodesById);
    for (const member of path.slice(1)) {
      loop.push(member);
      remainingMembers.delete(member);
    }
    currentMember = targetMember;
  }
  loop.push(...blockedByPath(currentMember, firstMember, cycleMembers, nodesById).slice(1));
  return loop;
}

/**
 * Breadth-first path over actual in-component blocked-by edges. Each member is
 * queued once through `visitedMembers`, bounding the loop to the component.
 */
function blockedByPath(
  firstMember: string,
  lastMember: string,
  cycleMembers: Set<string>,
  nodesById: Map<string, BlockingNode>,
): string[] {
  const pendingPaths = [[firstMember]];
  const visitedMembers = new Set([firstMember]);
  for (const path of pendingPaths) {
    const currentMember = path[path.length - 1];
    if (currentMember === undefined)
      throw new Error("cannot render blocked-by loop: path queue lost its current member");
    const node = nodesById.get(currentMember);
    if (node === undefined)
      throw new Error(
        `cannot render blocked-by loop: member "${currentMember}" has no blocking node — inspect its board card`,
      );
    for (const nextMember of node.blockedBy) {
      if (!cycleMembers.has(nextMember) || visitedMembers.has(nextMember)) continue;
      const nextPath = [...path, nextMember];
      if (nextMember === lastMember) return nextPath;
      visitedMembers.add(nextMember);
      pendingPaths.push(nextPath);
    }
  }
  throw new Error(
    `cannot render blocked-by loop: no in-cycle path from "${firstMember}" to "${lastMember}" — inspect their blocked-by links`,
  );
}

/**
 * Tarjan's strongly-connected-components. Each id is assigned an index exactly
 * once and each edge is followed once, so `compute` terminates in O(V+E), with
 * recursion depth bounded by the node count — a begin column, never deep. The
 * traversal state is the instance's own, so nothing mutates a shared argument;
 * a fresh instance is one run. Returns every component; the caller keeps the
 * ones that are cycles.
 */
class StronglyConnectedComponents {
  private counter = 0;
  private readonly index = new Map<string, number>();
  private readonly lowlink = new Map<string, number>();
  private readonly onStack = new Set<string>();
  private readonly stack: string[] = [];
  private readonly components: string[][] = [];

  constructor(private readonly edges: Map<string, string[]>) {}

  compute(ids: string[]): string[][] {
    for (const id of ids) if (!this.index.has(id)) this.visit(id);
    return this.components;
  }

  /** Visit one node, recurse into unvisited neighbours, then close its root's component. */
  private visit(id: string): void {
    this.index.set(id, this.counter);
    this.lowlink.set(id, this.counter);
    this.counter += 1;
    this.stack.push(id);
    this.onStack.add(id);
    for (const neighbor of this.edges.get(id) ?? []) this.relax(id, neighbor);
    if (this.at(this.lowlink, id) === this.at(this.index, id)) this.popComponent(id);
  }

  /** Fold a neighbour's reachability into this node's lowlink. */
  private relax(id: string, neighbor: string): void {
    if (!this.index.has(neighbor)) {
      this.visit(neighbor);
      this.lowlink.set(id, Math.min(this.at(this.lowlink, id), this.at(this.lowlink, neighbor)));
    } else if (this.onStack.has(neighbor)) {
      this.lowlink.set(id, Math.min(this.at(this.lowlink, id), this.at(this.index, neighbor)));
    }
  }

  /** Pop the stack down to `root`, emitting those nodes as one component. */
  private popComponent(root: string): void {
    const component: string[] = [];
    while (this.stack.length > 0) {
      const member = this.stack.pop();
      if (member === undefined) break;
      this.onStack.delete(member);
      component.push(member);
      if (member === root) {
        this.components.push(component);
        return;
      }
    }
    throw new Error(
      `SCC traversal drained the stack without reaching root "${root}" — a component was left open`,
    );
  }

  /** An index/lowlink value `visit` always sets before any read; its absence is a bug, not a value. */
  private at(map: Map<string, number>, key: string): number {
    const value = map.get(key);
    if (value === undefined)
      throw new Error(`SCC traversal read node "${key}" before assigning it an index`);
    return value;
  }
}
