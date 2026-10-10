import type { GraphSnapshot } from "./types.js";

/** Detect malformed fixtures/provider results; never silently trust graph edges. */
export function validateSnapshot(snapshot: GraphSnapshot): string[] {
  const problems: string[] = [];
  const ids = new Set(snapshot.nodes.map((n) => n.id));
  if (snapshot.nodes.length !== ids.size) problems.push("Duplicate node IDs");
  if (!ids.has(snapshot.rootPositionId)) problems.push("Root position node not found");
  if (snapshot.rootPositionUsd < 0 || !Number.isFinite(snapshot.rootPositionUsd)) problems.push("Invalid position USD value");
  const edgeIds = new Set<string>();
  for (const e of snapshot.edges) {
    if (edgeIds.has(e.id)) problems.push(`Duplicate edge ID: ${e.id}`);
    edgeIds.add(e.id);
    if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`Dangling edge: ${e.id}`);
    if (e.allocationBps !== undefined && (e.kind !== "ALLOCATES_TO" || !Number.isFinite(e.allocationBps) || e.allocationBps < 0 || e.allocationBps > 10000)) {
      problems.push(`Invalid allocation: ${e.id}`);
    }
    if (!e.evidence.reference) problems.push(`Edge lacks evidence: ${e.id}`);
  }
  return problems;
}

/** Reverse traversal: from failed dependency to all things depending on it. */
export function affectedPaths(snapshot: GraphSnapshot, failedNodeId: string): string[][] {
  const reverse = new Map<string, string[]>();
  for (const e of snapshot.edges) {
    const xs = reverse.get(e.to) ?? [];
    xs.push(e.from);
    reverse.set(e.to, xs);
  }
  const paths: string[][] = [];
  const queue: string[][] = [[failedNodeId]];
  const maxDepth = 20;
  while (queue.length) {
    const path = queue.shift()!;
    const node = path[path.length - 1]!;
    if (node === snapshot.rootPositionId) {
      paths.push(path);
      continue;
    }
    if (path.length >= maxDepth) continue;
    for (const dependent of reverse.get(node) ?? []) {
      if (!path.includes(dependent)) queue.push([...path, dependent]);
    }
  }
  return paths;
}
