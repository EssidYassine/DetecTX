"use client";

import { useEffect, useState } from "react";
import {
  addShortcut,
  deleteShortcut,
  fetchShortcuts,
  fetchStartup,
  getLocation,
  launchShortcut,
  setLocation,
  toggleStartup,
  type Shortcut,
  type StartupItem,
} from "@/lib/api";

function Switch({ on, disabled, onToggle }: { on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className="relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50"
      style={{ backgroundColor: on ? "var(--ok)" : "var(--surface-2)", border: "1px solid var(--line)" }}
      aria-pressed={on}
    >
      <span className="absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all" style={{ left: on ? "22px" : "3px", width: 18, height: 18 }} />
    </button>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="panel relative z-10 flex max-h-[82dvh] w-full max-w-lg flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="font-display font-semibold">{title}</h3>
          <button onClick={onClose} className="text-muted transition hover:text-foreground">✕</button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent";

const ICON = {
  location: "M12 21s7-6.5 7-11a7 7 0 10-14 0c0 4.5 7 11 7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  startup: "M5 12h14M12 5v14M4 4h16v16H4z",
  launcher: "M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1",
};

function IconButton({ title, onClick, disabled, active, path }: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  /** État « protection active » (accent) — le rouge reste réservé au critique. */
  active?: boolean;
  path: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`grid h-8 w-8 place-items-center rounded-lg border transition disabled:opacity-50 ${
        active
          ? "border-accent/60 bg-accent/10 text-accent"
          : "border-line text-muted hover:border-accent/60 hover:text-accent"
      }`}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </button>
  );
}

/** Contrôle du poste en format compact (en-tête du widget hôte de l'Overview). */
export function SystemControlButtons() {
  const [loc, setLoc] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"startup" | "shortcut" | null>(null);

  useEffect(() => {
    getLocation().then((r) => setLoc(r.allowed)).catch(() => setLoc(null));
  }, []);

  async function toggleLoc() {
    if (loc === null || busy) return;
    const next = !loc;
    if (!next && !confirm("Bloquer l’accès des applications à ta localisation ?")) return;
    setBusy(true);
    try {
      await setLocation(next);
      setLoc(next);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Échec");
    } finally {
      setBusy(false);
    }
  }

  const locTitle =
    loc === null ? "Partage de localisation : état inconnu" : loc ? "Localisation autorisée — cliquer pour bloquer" : "Localisation bloquée — cliquer pour autoriser";

  return (
    <div className="flex items-center gap-1.5">
      <IconButton title={locTitle} onClick={toggleLoc} disabled={loc === null || busy} active={loc === false} path={ICON.location} />
      <IconButton title="Applications au démarrage" onClick={() => setModal("startup")} path={ICON.startup} />
      <IconButton title="Mes raccourcis" onClick={() => setModal("shortcut")} path={ICON.launcher} />
      {modal === "startup" && <StartupModal onClose={() => setModal(null)} />}
      {modal === "shortcut" && <LauncherModal onClose={() => setModal(null)} />}
    </div>
  );
}

function StartupModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<StartupItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => fetchStartup().then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  useEffect(() => { void load(); }, []);

  async function onToggle(it: StartupItem) {
    try {
      await toggleStartup(it.name, !it.enabled);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Échec");
    }
  }

  return (
    <Modal title="Applications au démarrage" onClose={onClose}>
      {loading ? (
        <p className="text-sm text-muted">Chargement…</p>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={`${it.location}-${it.name}`} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{it.name}</p>
                <p className="truncate text-xs text-muted">{it.location} · {it.command}</p>
              </div>
              {it.editable ? (
                <Switch on={it.enabled} onToggle={() => onToggle(it)} />
              ) : (
                <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs text-muted">système</span>
              )}
            </div>
          ))}
          <p className="pt-2 text-xs text-muted">
            Seules les entrées <span className="text-accent">HKCU</span> sont modifiables ici (niveau utilisateur, sans admin).
          </p>
        </div>
      )}
    </Modal>
  );
}

function LauncherModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Shortcut[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ icon: "", label: "", target: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => fetchShortcuts().then(setItems).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);

  async function launch(sc: Shortcut) {
    try {
      await launchShortcut(sc.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Lancement échoué");
    }
  }
  async function remove(sc: Shortcut) {
    if (!confirm(`Supprimer le bouton « ${sc.label} » ?`)) return;
    await deleteShortcut(sc.id).catch(() => {});
    await load();
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await addShortcut({ label: form.label, target: form.target, icon: form.icon || undefined });
      setForm({ icon: "", label: "", target: "" });
      setAdding(false);
      await load();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "Échec");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Mes raccourcis" onClose={onClose}>
      <p className="mb-3 text-xs text-muted">
        Définis tes propres boutons pour lancer une application ou une URL en un clic.
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((sc) => (
          <div key={sc.id} className="group relative">
            <button
              onClick={() => launch(sc)}
              title={sc.target}
              className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-line bg-surface-2/40 p-3 transition hover:-translate-y-0.5 hover:border-accent/60 hover:bg-surface-2"
            >
              <span className="text-2xl leading-none">{sc.icon || "▸"}</span>
              <span className="w-full truncate text-center text-xs">{sc.label}</span>
            </button>
            <button
              onClick={() => remove(sc)}
              className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 place-items-center rounded-full text-xs text-white group-hover:grid"
              style={{ backgroundColor: "var(--critical)" }}
            >
              ×
            </button>
          </div>
        ))}
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line p-3 text-muted transition hover:border-accent/60 hover:text-accent"
          >
            <span className="text-2xl leading-none">＋</span>
            <span className="text-xs">Ajouter</span>
          </button>
        )}
      </div>

      {items.length === 0 && !adding && (
        <p className="mt-3 text-center text-xs text-muted">Aucun bouton. Clique sur « ＋ Ajouter ».</p>
      )}

      {adding && (
        <form onSubmit={add} className="mt-4 space-y-2 rounded-xl border border-line p-3">
          <div className="flex gap-2">
            <input value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} maxLength={2} placeholder="🚀" className={`${inputCls} w-14 text-center`} />
            <input required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Nom (ex. Kali VM)" className={inputCls} />
          </div>
          <input required value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="C:\\Users\\…\\KALI VM.lnk  ou  https://…" className={inputCls} />
          {err && <p className="text-xs text-critical">{err}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-accent py-2 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50">
              {busy ? "…" : "Créer le bouton"}
            </button>
            <button type="button" onClick={() => { setAdding(false); setForm({ icon: "", label: "", target: "" }); }} className="rounded-lg border border-line px-3 text-sm text-muted transition hover:text-foreground">
              Annuler
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

