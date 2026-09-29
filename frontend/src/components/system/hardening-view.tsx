"use client";

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { applyRemedy, revertRemedy, type HardeningControl, type HardeningSnapshot, type RemedyRecord, type User } from "@/lib/api";
import { controlTone, GRADE_TONE, LEVEL_LABEL, safeLink, sortControls, STATE_LABEL } from "@/lib/hardening";
import { relTime } from "@/lib/persistence";
import { ScenePoster } from "@/components/three/scene-poster";
import type { LockHover } from "@/components/three/lock";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { NoticeLine, type Notice } from "./process-details";
import { RemedyAction } from "./remedy-action";

const Lock = dynamic(() => import("@/components/three/lock"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/lock_poster.png" />,
});

const hoverKey = (h: LockHover) => h.id;

interface HardeningViewProps {
  snapshot: HardeningSnapshot | null;
  history: RemedyRecord[];
  error: string | null;
  user: User | null;
  onChanged: () => Promise<void> | void;
}

/** Vue Durcissement : la serrure (3D), les contrôles, la fiche avec son remède, l'historique. */
export function HardeningView({ snapshot, history, error, user, onChanged }: HardeningViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showOk, setShowOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<LockHover>(panel, hoverKey);

  const controls = useMemo(() => sortControls(snapshot?.controls ?? []), [snapshot]);
  const weak = controls.filter((c) => c.state === "weak");
  const rest = controls.filter((c) => c.state !== "weak");
  const current = controls.find((c) => c.id === selected) ?? weak[0] ?? controls[0] ?? null;
  const hovered = hover ? controls.find((c) => c.id === hover.id) : undefined;
  const isAdmin = user?.role === "admin";
  const s = snapshot?.summary;

  async function act(work: () => Promise<Notice>) {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await work());
      await onChanged();
    } catch (e) {
      setNotice({ tone: "critical", text: e instanceof Error ? e.message : "Correction impossible." });
    } finally {
      setBusy(false);
    }
  }

  const fix = (id: string) =>
    void act(async () => {
      const r = await applyRemedy(id);
      return { tone: "ok", text: r.detail };
    });
  const undo = (record: RemedyRecord) =>
    void act(async () => {
      const r = await revertRemedy(record.id);
      return { tone: "ok", text: r.detail };
    });

  return (
    <>
      {/* Serrure 3D */}
      <div ref={panel} className="panel relative flex min-h-0 flex-col overflow-hidden h-[26rem] lg:col-span-5 lg:row-span-2 lg:h-auto">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="eyebrow">La serrure du poste</span>
          {s && (
            <span className="ml-auto font-mono text-sm font-semibold tabular-nums" style={{ color: `var(--${GRADE_TONE[s.grade]})` }}>
              {s.score}/100
            </span>
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          {snapshot ? <Lock snapshot={snapshot} selected={current?.id ?? null} onHover={onHover} onSelect={setSelected} /> : <p className="p-6 text-sm text-muted">{error ?? "Lecture de la configuration de Windows…"}</p>}
        </div>
        {s && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[11px]">
            <span className="text-critical">{s.weak.high} important{s.weak.high > 1 ? "s" : ""}</span>
            <span className="text-warn">{s.weak.medium + s.weak.low} à améliorer</span>
            <span className="text-accent">{s.ok} en place</span>
            <span className="ml-auto text-muted">{s.fixable} corrigeable{s.fixable > 1 ? "s" : ""} d&apos;un clic</span>
          </div>
        )}
        {hover && hovered && (
          <HoverTip hover={hover} tipRef={tip}>
            <p className="font-medium">{hovered.title}</p>
            <p className="mt-0.5" style={{ color: `var(--${controlTone(hovered)})` }}>
              {STATE_LABEL[hovered.state]}
              {hovered.state === "weak" && ` · ${LEVEL_LABEL[hovered.level]}`}
            </p>
            <p className="mt-0.5 text-[10px] text-muted">Clic : fiche et correction</p>
          </HoverTip>
        )}
      </div>

      {/* Contrôles */}
      <div className="panel flex min-h-0 flex-col overflow-hidden h-[24rem] lg:col-span-4 lg:row-span-2 lg:h-auto">
        <div className="border-b border-line px-4 py-2.5">
          <span className="eyebrow">Contrôles de durcissement</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {weak.length > 0 ? (
            <Section title={`À renforcer (${weak.length})`}>
              {weak.map((c) => (
                <ControlRow key={c.id} c={c} active={c.id === current?.id} onSelect={setSelected} theme={snapshot?.themes[c.theme]} />
              ))}
            </Section>
          ) : (
            snapshot && (
              <p className="flex items-center gap-2 border-b border-line bg-accent/5 px-4 py-2 text-xs text-accent">
                <span aria-hidden="true">✓</span> Tous les verrous vérifiables sont en place.
              </p>
            )
          )}
          <button onClick={() => setShowOk((v) => !v)} aria-expanded={showOk} className="flex w-full items-center justify-between border-b border-line/60 px-4 py-2 text-left text-[11px] text-muted hover:text-foreground">
            <span>En place, sans objet ou illisibles ({rest.length})</span>
            <span>{showOk ? "▾" : "▸"}</span>
          </button>
          {showOk && rest.map((c) => <ControlRow key={c.id} c={c} active={c.id === current?.id} onSelect={setSelected} theme={snapshot?.themes[c.theme]} />)}
        </div>
      </div>

      {/* Fiche du contrôle */}
      <div className="panel flex min-h-0 flex-col overflow-hidden h-[24rem] lg:col-span-3 lg:h-auto">
        {current ? (
          <ControlCard c={current} meta={current.remedy ? snapshot?.remedies[current.remedy] : undefined} busy={busy} notice={notice} isAdmin={isAdmin} onFix={fix} />
        ) : (
          <p className="m-auto p-6 text-center text-sm text-muted">{error ?? "Choisissez un contrôle."}</p>
        )}
      </div>

      {/* Historique des corrections */}
      <div className="panel flex min-h-0 flex-col overflow-hidden h-[16rem] lg:col-span-3 lg:h-auto">
        <div className="border-b border-line px-4 py-2.5">
          <span className="eyebrow">Corrections appliquées</span>
        </div>
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3 text-xs">
          {history.length === 0 && <li className="p-3 text-center text-muted">Aucune correction pour l&apos;instant.</li>}
          {history.map((r) => (
            <li key={r.id} className="rounded-lg border border-line px-2.5 py-1.5">
              <p className={`font-medium ${r.reverted_at ? "text-muted line-through" : ""}`}>{r.label}</p>
              <p className="text-[10px] text-muted">
                {relTime(r.at)} · {r.actor}
                {r.reverted_at && ` · annulée le ${relTime(r.reverted_at)}`}
                {!r.reverted_at && r.reboot && <span className="text-warn"> · redémarrage requis</span>}
              </p>
              {isAdmin && r.revertible && !r.reverted_at && (
                <button onClick={() => undo(r)} disabled={busy} className="mt-0.5 text-[11px] text-accent hover:underline disabled:opacity-50">
                  Annuler cette correction
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="border-b border-line/60 bg-surface-2/40 px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</p>
      {children}
    </div>
  );
}

function ControlRow({ c, active, onSelect, theme }: { c: HardeningControl; active: boolean; onSelect: (id: string) => void; theme?: string }) {
  const tone = controlTone(c);
  return (
    <button onClick={() => onSelect(c.id)} aria-current={active} className={`flex w-full items-center gap-2.5 border-b border-line/50 px-4 py-2 text-left transition ${active ? "bg-accent/10" : "hover:bg-surface-2/70"}`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--${tone})` }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{c.title}</span>
        <span className="block truncate text-[10px] text-muted">{theme}</span>
      </span>
      {c.state === "weak" && c.remedy && <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[10px] text-accent">corrigeable</span>}
      {c.state !== "weak" && <span className="shrink-0 text-[10px] text-muted">{STATE_LABEL[c.state]}</span>}
    </button>
  );
}

function ControlCard({ c, meta, busy, notice, isAdmin, onFix }: { c: HardeningControl; meta?: { title: string; change: string; reboot: boolean; revertible: boolean }; busy: boolean; notice: Notice | null; isAdmin: boolean; onFix: (id: string) => void }) {
  const tone = controlTone(c);
  return (
    <>
      <div className="border-b border-line px-4 py-2.5">
        <p className="text-[11px]" style={{ color: `var(--${tone})` }}>
          {STATE_LABEL[c.state]}
          {c.state === "weak" && ` · risque ${LEVEL_LABEL[c.level]}`}
        </p>
        <p className="mt-0.5 font-semibold leading-snug">{c.title}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
        <p>{c.why}</p>
        <div>
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">Ce qui a été lu</p>
          <p className="break-all font-mono text-[10px] text-muted">{c.observed}</p>
          {c.details.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[10px] text-muted">
              {c.details.map((d) => (
                <li key={d}>• {d}</li>
              ))}
            </ul>
          )}
        </div>
        {c.attack && (
          <p className="text-[11px] text-muted">
            Technique visée :{" "}
            <Link href={`/dashboard/mitre?mitre=${encodeURIComponent(c.attack)}`} className="font-mono text-accent hover:underline">
              {c.attack}
            </Link>
          </p>
        )}
        {c.state === "weak" && (
          <div className="space-y-2 border-t border-line pt-2.5">
            {c.advice && <p className="text-[11px]">{c.advice}</p>}
            {c.remedy && meta && isAdmin && (
              <RemedyAction label="Corriger" title={meta.title} change={meta.change} reboot={meta.reboot} revertible={meta.revertible} tone={c.level === "high" ? "critical" : "warn"} busy={busy} onConfirm={() => onFix(c.remedy!)} />
            )}
            {c.remedy && !isAdmin && <p className="text-[11px] text-muted">Seul un administrateur DeTecTX peut appliquer la correction.</p>}
            {c.link && safeLink(c.link.uri) && (
              <a
                href={c.link.uri}
                {...(c.link.uri.startsWith("https://") ? { target: "_blank", rel: "noreferrer noopener" } : {})}
                className="block w-full rounded-md border border-line px-3 py-1.5 text-center text-xs transition hover:border-accent/60 hover:text-accent"
              >
                {c.link.label} ↗
              </a>
            )}
          </div>
        )}
        <NoticeLine notice={notice} />
      </div>
    </>
  );
}
