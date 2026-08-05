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
  const components = stronglyConnectedComponents(
    nodes.map((node) => node.id),
    edges,
  );
  return components
    .filter((members) => members.length > 1 || members.some((member) => selfBlocked.has(member)))
    .map((members) => [...members].sort())
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

/**
 * Tarjan's strongly-connected-components. Each id is assigned an index exactly
 * once and each edge is followed once, so the traversal terminates in O(V+E);
 * recursion depth is bounded by the node count — a begin column, never deep.
 * Returns every component; the caller keeps the ones that are cycles.
 */
function stronglyConnectedComponents(ids: string[], edges: Map<string, string[]>): string[][] {
  const state: SccState = {
    edges,
    counter: 0,
    index: new Map(),
    lowlink: new Map(),
    onStack: new Set(),
    stack: [],
    components: [],
  };
  for (const id of ids) if (!state.index.has(id)) sccVisit(id, state);
  return state.components;
}

/** The running state one SCC traversal threads through its helpers. */
interface SccState {
  edges: Map<string, string[]>;
  counter: number;
  index: Map<string, number>;
  lowlink: Map<string, number>;
  onStack: Set<string>;
  stack: string[];
  components: string[][];
}

/** Visit one node, recurse into unvisited neighbours, then close its component. */
function sccVisit(id: string, state: SccState): void {
  state.index.set(id, state.counter);
  state.lowlink.set(id, state.counter);
  state.counter += 1;
  state.stack.push(id);
  state.onStack.add(id);
  for (const neighbor of state.edges.get(id) ?? []) sccRelax(id, neighbor, state);
  if (numberAt(state.lowlink, id) === numberAt(state.index, id)) sccPopComponent(id, state);
}

/** Fold a neighbour's reachability into this node's lowlink. */
function sccRelax(id: string, neighbor: string, state: SccState): void {
  if (!state.index.has(neighbor)) {
    sccVisit(neighbor, state);
    state.lowlink.set(id, Math.min(numberAt(state.lowlink, id), numberAt(state.lowlink, neighbor)));
  } else if (state.onStack.has(neighbor)) {
    state.lowlink.set(id, Math.min(numberAt(state.lowlink, id), numberAt(state.index, neighbor)));
  }
}

/** Pop the stack down to `root`, emitting those nodes as one component. */
function sccPopComponent(root: string, state: SccState): void {
  const component: string[] = [];
  while (state.stack.length > 0) {
    const member = state.stack.pop();
    if (member === undefined) break;
    state.onStack.delete(member);
    component.push(member);
    if (member === root) break;
  }
  state.components.push(component);
}

/** A Map value the algorithm always sets before it reads; the floor is unreached. */
function numberAt(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}
