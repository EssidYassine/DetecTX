// Regroupement des processus par application (même exécutable) : ce que l'utilisateur appelle
// « Chrome » ou « Obsidian » est souvent une dizaine de processus. La fenêtre appartient au
// processus principal ; arrêter un sous-processus seul laisse une fenêtre vide (moteur de
// rendu tué). D'où des actions pensées à l'échelle de l'application.

import type { ProcInfo } from "./api";
import { hintsFor, type ProcTree, type TreeNode } from "./proctree";

export type AppCategory = "window" | "background" | "system";

export interface AppGroup {
  key: string;
  name: string;
  exe: string | null;
  members: TreeNode[];
  /** Membres dont le parent n'est pas le même exécutable (un navigateur : 1 ; svchost : des dizaines). */
  roots: TreeNode[];
  primary: TreeNode; // racine propriétaire d'une fenêtre, sinon la plus lourde
  windowOwner: TreeNode | null;
  windows: number;
  cpu: number; // % d'UN cœur, cumulé
  rss: number;
  memory: number; // % de la RAM, cumulé
  category: AppCategory;
  hints: number;
}

export const CATEGORY_LABEL: Record<AppCategory, string> = {
  window: "Applications ouvertes",
  background: "Arrière-plan",
  system: "Windows & système",
};

/** Identité d'un exécutable : chemin complet si lisible, sinon nom. */
export const exeKey = (p: ProcInfo) => (p.exe ?? p.name ?? `pid:${p.pid}`).toLowerCase();

/** Processus principal de l'application d'un nœud : on remonte tant que le parent est le même exécutable. */
export function appRootOf(node: TreeNode): TreeNode {
  let n = node;
  while (n.parent && exeKey(n.parent.proc) === exeKey(n.proc)) n = n.parent;
  return n;
}

/** Tous les processus sous `node` (lui compris), dans l'ordre parent -> enfants. */
export function subtree(node: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

export function buildApps(tree: ProcTree): AppGroup[] {
  const groups = new Map<string, TreeNode[]>();
  tree.byPid.forEach((node) => {
    const key = exeKey(node.proc);
    groups.set(key, [...(groups.get(key) ?? []), node]);
  });

  const apps: AppGroup[] = [];
  groups.forEach((members, key) => {
    const roots = members.filter((m) => !m.parent || exeKey(m.parent.proc) !== key);
    const owners = members.filter((m) => (m.proc.windows ?? 0) > 0);
    const heaviest = [...roots].sort((a, b) => (b.proc.rss ?? 0) - (a.proc.rss ?? 0))[0] ?? members[0];
    const windowOwner = owners.find((o) => roots.includes(o)) ?? owners[0] ?? null;
    const first = members[0].proc;
    const exe = first.exe;
    const windows = owners.reduce((s, o) => s + (o.proc.windows ?? 0), 0);
    apps.push({
      key,
      name: first.name ?? `PID ${first.pid}`,
      exe,
      members,
      roots,
      primary: windowOwner && roots.includes(windowOwner) ? windowOwner : heaviest,
      windowOwner,
      windows,
      cpu: members.reduce((s, m) => s + m.proc.cpu_percent, 0),
      rss: members.reduce((s, m) => s + (m.proc.rss ?? 0), 0),
      memory: members.reduce((s, m) => s + m.proc.memory_percent, 0),
      category: windows > 0 ? "window" : !exe || exe.toLowerCase().startsWith("c:\\windows\\") ? "system" : "background",
      hints: members.filter((m) => hintsFor(m).length > 0).length,
    });
  });
  return apps;
}

export type AppSort = "memory" | "cpu" | "name";

export function sortApps(apps: AppGroup[], by: AppSort): AppGroup[] {
  const cmp: Record<AppSort, (a: AppGroup, b: AppGroup) => number> = {
    memory: (a, b) => b.rss - a.rss,
    cpu: (a, b) => b.cpu - a.cpu || b.rss - a.rss,
    name: (a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
  };
  return [...apps].sort(cmp[by]);
}

/** Recherche par nom, PID (d'un des processus) ou chemin. */
export function matchApp(app: AppGroup, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return app.name.toLowerCase().includes(q) || (app.exe ?? "").toLowerCase().includes(q) || app.members.some((m) => String(m.proc.pid) === q);
}
