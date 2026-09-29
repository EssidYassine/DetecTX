// Arborescence des processus (parent -> enfants) et indices d'analyse.
//
// Les indices sont volontairement peu nombreux et formulés comme des pistes à vérifier, pas
// comme des verdicts : la détection proprement dite reste le rôle du moteur Sigma sur les
// événements. Ils aident l'analyste à repérer d'un coup d'œil ce qui mérite un clic.

import type { ProcInfo } from "./api";

export interface TreeNode {
  proc: ProcInfo;
  parent: TreeNode | null;
  children: TreeNode[];
  /** Nombre total de descendants (enfants, petits-enfants…). */
  descendants: number;
}

export interface ProcTree {
  roots: TreeNode[];
  byPid: Map<number, TreeNode>;
}

const startMs = (p: ProcInfo) => (p.started_at ? Date.parse(p.started_at) : Number.NaN);

/**
 * Construit l'arbre. Windows réutilise les PID : un « parent » démarré APRÈS son enfant n'est
 * pas son vrai parent (l'original est mort, son PID a été recyclé) -> l'enfant devient racine.
 */
export function buildTree(procs: ProcInfo[]): ProcTree {
  const byPid = new Map<number, TreeNode>();
  procs.forEach((proc) => byPid.set(proc.pid, { proc, parent: null, children: [], descendants: 0 }));

  const roots: TreeNode[] = [];
  byPid.forEach((node) => {
    const { ppid, pid } = node.proc;
    const parent = ppid !== null && ppid !== pid ? byPid.get(ppid) : undefined;
    const parentStart = parent ? startMs(parent.proc) : Number.NaN;
    const childStart = startMs(node.proc);
    const recycled = parent !== undefined && parentStart > childStart + 1000; // 1 s de tolérance d'horloge
    if (parent && !recycled && !isAncestor(node, parent)) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  const byName = (a: TreeNode, b: TreeNode) =>
    (a.proc.name ?? "").localeCompare(b.proc.name ?? "", "fr", { sensitivity: "base" }) || a.proc.pid - b.proc.pid;
  const finish = (node: TreeNode): number => {
    node.children.sort(byName);
    node.descendants = node.children.reduce((sum, c) => sum + 1 + finish(c), 0);
    return node.descendants;
  };
  roots.sort((a, b) => a.proc.pid - b.proc.pid);
  roots.forEach(finish);
  return { roots, byPid };
}

/** Garde-fou contre les cycles (données incohérentes entre deux lectures). */
function isAncestor(candidate: TreeNode, node: TreeNode | null): boolean {
  for (let n = node; n; n = n.parent) if (n === candidate) return true;
  return false;
}

// ─────────────────────────────── indices
export interface Hint {
  id: "office-shell" | "temp-path" | "masquerade" | "svchost-parent" | "encoded-command" | "unsigned-user" | "proxy-exec";
  label: string;
  /** Technique MITRE ATT&CK correspondante (référence, pas un verdict). */
  attack: string;
}

const OFFICE = new Set(["winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe", "onenote.exe", "msaccess.exe", "mspub.exe", "acrord32.exe", "acrobat.exe"]);
const INTERPRETERS = new Set([
  "cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe", "mshta.exe",
  "rundll32.exe", "regsvr32.exe", "certutil.exe", "bitsadmin.exe",
]);
// Binaires système et leur dossier légitime (en minuscules).
const SYSTEM_BINARIES: Record<string, string[]> = {
  "svchost.exe": ["c:\\windows\\system32", "c:\\windows\\syswow64"],
  "lsass.exe": ["c:\\windows\\system32"],
  "csrss.exe": ["c:\\windows\\system32"],
  "winlogon.exe": ["c:\\windows\\system32"],
  "services.exe": ["c:\\windows\\system32"],
  "smss.exe": ["c:\\windows\\system32"],
  "wininit.exe": ["c:\\windows\\system32"],
  "explorer.exe": ["c:\\windows"],
};
const TEMP_DIRS = ["\\appdata\\local\\temp\\", "\\downloads\\", "\\users\\public\\", "\\$recycle.bin\\", "\\windows\\temp\\"];

const USER_DIRS = ["\\appdata\\", "\\downloads\\", "\\temp\\", "\\users\\public\\"];
// PowerShell : -enc / -EncodedCommand (et ses abréviations -e, -en, -ec…) suivi d'un bloc base64,
// ou script téléchargé puis exécuté en mémoire.
const ENCODED = /(?:^|\s)[-/](?:e|ec|en[a-z]*)\s+[a-z0-9+/=]{16,}|frombase64string|downloadstring|invoke-expression|\biex\b/i;
// Binaires Windows détournés pour exécuter du code distant ou hors des dossiers système.
const PROXIES = new Set(["rundll32.exe", "regsvr32.exe", "mshta.exe"]);
const REMOTE_OR_USER = /https?:|javascript:|vbscript:|\\appdata\\|\\temp\\|\\downloads\\|\\users\\public\\|scrobj\.dll/i;

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("\\")).toLowerCase();

export function hintsFor(node: TreeNode): Hint[] {
  const hints: Hint[] = [];
  const name = (node.proc.name ?? "").toLowerCase();
  const exe = node.proc.exe;
  const parentName = (node.parent?.proc.name ?? "").toLowerCase();

  if (OFFICE.has(parentName) && INTERPRETERS.has(name)) {
    hints.push({ id: "office-shell", label: `Lancé par ${node.parent?.proc.name} : un document qui ouvre un interpréteur`, attack: "T1204" });
  }
  if (exe && TEMP_DIRS.some((d) => exe.toLowerCase().includes(d))) {
    hints.push({ id: "temp-path", label: "Exécuté depuis un dossier temporaire ou de téléchargement", attack: "T1204" });
  }
  const legit = SYSTEM_BINARIES[name];
  if (legit && exe && !legit.includes(dirOf(exe))) {
    hints.push({ id: "masquerade", label: `Nom d'un binaire système, mais hors de son dossier (${dirOf(exe)})`, attack: "T1036" });
  }
  if (name === "svchost.exe" && node.parent && parentName !== "services.exe") {
    hints.push({ id: "svchost-parent", label: `svchost.exe lancé par ${node.parent.proc.name} au lieu de services.exe`, attack: "T1036" });
  }
  const cmd = node.proc.cmdline ?? "";
  if ((name === "powershell.exe" || name === "pwsh.exe") && ENCODED.test(cmd)) {
    hints.push({ id: "encoded-command", label: "PowerShell avec commande encodée ou téléchargée", attack: "T1059.001" });
  }
  const sig = node.proc.signature?.verdict;
  if ((sig === "unsigned" || sig === "invalid") && exe && USER_DIRS.some((d) => exe.toLowerCase().includes(d))) {
    hints.push({ id: "unsigned-user", label: "Programme non signé lancé depuis un dossier utilisateur", attack: "T1204.002" });
  }
  if (PROXIES.has(name) && REMOTE_OR_USER.test(cmd)) {
    hints.push({ id: "proxy-exec", label: `${node.proc.name} charge du code distant ou d'un dossier utilisateur`, attack: "T1218" });
  }
  return hints;
}
