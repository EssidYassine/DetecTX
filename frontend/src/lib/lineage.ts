// Disposition de la « lignée » d'une application en cinq couloirs :
//   0 grand-parents · 1 parents · 2 APPLICATION (ses processus racines) · 3 enfants · 4 descendants.
// Chaque couloir est plafonné ; le surplus devient un nœud « +N ». Les nœuds sont ordonnés
// selon leur parent pour limiter les croisements de liens. Sans dépendance three.js.

import type { AppGroup } from "./apps";
import type { TreeNode } from "./proctree";

export const LANES = 5;
export const LANE_TITLES = ["Grand-parent", "Parent", "Application", "Enfants", "Descendants"] as const;
const CAP = [3, 6, 10, 12, 12];

export interface LineageNode {
  key: string;
  lane: number;
  slot: number;
  node: TreeNode | null; // null = nœud de surplus
  overflow: number; // > 0 pour un nœud « +N »
  inApp: boolean;
}

export interface Lineage {
  nodes: LineageNode[];
  edges: [string, string][]; // clé parent -> clé enfant
  totals: number[]; // nombre réel de processus par couloir (avant plafonnement)
  slots: number[]; // nombre de positions occupées par couloir
}

const keyOf = (n: TreeNode) => `p:${n.proc.pid}`;
const byWeight = (a: TreeNode, b: TreeNode) => (b.proc.rss ?? 0) - (a.proc.rss ?? 0);

export function buildLineage(app: AppGroup, focus: TreeNode | null): Lineage {
  const lanes: TreeNode[][] = [[], [], [], [], []];
  const totals = [0, 0, 0, 0, 0];

  // Couloir 2 : racines de l'application, la principale (et celle du focus) d'abord.
  const focusRoot = focus ? app.roots.find((r) => r === focus || isUnder(focus, r)) : undefined;
  const roots = uniq([app.primary, ...(focusRoot ? [focusRoot] : []), ...[...app.roots].sort(byWeight)]);
  totals[2] = roots.length;
  lanes[2] = roots;

  const shown = (lane: number) => lanes[lane].slice(0, CAP[lane]);

  // Couloirs 1 et 0 : parents puis grands-parents des nœuds affichés.
  totals[1] = uniq(shown(2).flatMap((r) => (r.parent ? [r.parent] : []))).length;
  lanes[1] = uniq(shown(2).flatMap((r) => (r.parent ? [r.parent] : [])));
  lanes[0] = uniq(shown(1).flatMap((p) => (p.parent ? [p.parent] : [])));
  totals[0] = lanes[0].length;

  // Couloir 3 : enfants directs des racines affichées (tous exécutables), dans l'ordre des racines.
  const children = shown(2).flatMap((r) => [...r.children].sort(byWeight));
  totals[3] = children.length;
  lanes[3] = prioritize(children, focus);

  // Couloir 4 : tous les descendants plus profonds des enfants affichés.
  const deeper: TreeNode[] = [];
  const walk = (n: TreeNode) =>
    n.children.forEach((c) => {
      deeper.push(c);
      walk(c);
    });
  shown(3).forEach(walk);
  totals[4] = deeper.length;
  lanes[4] = prioritize(deeper, focus);

  const nodes: LineageNode[] = [];
  const slots = [0, 0, 0, 0, 0];
  lanes.forEach((list, lane) => {
    const visible = list.slice(0, CAP[lane]);
    visible.forEach((n, slot) => nodes.push({ key: keyOf(n), lane, slot, node: n, overflow: 0, inApp: app.members.includes(n) }));
    const rest = totals[lane] - visible.length;
    if (rest > 0) nodes.push({ key: `o:${lane}`, lane, slot: visible.length, node: null, overflow: rest, inApp: false });
    slots[lane] = visible.length + (rest > 0 ? 1 : 0);
  });

  const present = new Set(nodes.map((n) => n.key));
  const edges: [string, string][] = [];
  nodes.forEach((n) => {
    const parent = n.node?.parent;
    if (parent && present.has(keyOf(parent))) edges.push([keyOf(parent), n.key]);
  });
  return { nodes, edges, totals, slots };
}

function uniq(list: TreeNode[]): TreeNode[] {
  return [...new Set(list)];
}

function isUnder(node: TreeNode, ancestor: TreeNode): boolean {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** Le processus sélectionné (ou son ancêtre dans ce couloir) reste toujours visible. */
function prioritize(list: TreeNode[], focus: TreeNode | null): TreeNode[] {
  if (!focus) return list;
  const hit = list.find((n) => n === focus || isUnder(focus, n));
  return hit ? [hit, ...list.filter((n) => n !== hit)] : list;
}
