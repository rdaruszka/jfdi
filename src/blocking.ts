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
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const connect = (id: string): void => {
    index.set(id, counter);
    lowlink.set(id, counter);
    counter++;
    stack.push(id);
    onStack.add(id);
    for (const neighbor of edges.get(id) ?? []) {
      if (!index.has(neighbor)) {
        connect(neighbor);
        lowlink.set(id, Math.min(lowlink.get(id) ?? counter, lowlink.get(neighbor) ?? counter));
      } else if (onStack.has(neighbor)) {
        lowlink.set(id, Math.min(lowlink.get(id) ?? counter, index.get(neighbor) ?? counter));
      }
    }
    if (lowlink.get(id) === index.get(id)) {
      const component: string[] = [];
      while (stack.length > 0) {
        const member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
        if (member === id) break;
      }
      components.push(component);
    }
  };

  for (const id of ids) if (!index.has(id)) connect(id);
  return components;
}
