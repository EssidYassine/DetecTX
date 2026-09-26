// Composants UI partagés DeTecTX.

export function shortChannel(channel: string | null): string {
  if (!channel) return "—";
  // "Microsoft-Windows-PowerShell/Operational" -> "PowerShell", "DeTecTX-FileMonitor" -> "FileMonitor"
  const base = channel.split("/")[0].replace(/^Microsoft-Windows-/, "").replace(/^DeTecTX-/, "");
  return base || channel;
}

const SEV_TONE: Record<string, string> = {
  critical: "critical",
  high: "warn",
  medium: "accent",
  low: "muted",
};

export function SeverityBadge({ severity }: { severity: string }) {
  const tone = SEV_TONE[severity] ?? "muted";
  return (
    <span
      className="rounded px-2 py-0.5 text-xs font-medium capitalize"
      style={{
        color: `var(--${tone})`,
        backgroundColor: `color-mix(in srgb, var(--${tone}) 15%, transparent)`,
      }}
    >
      {severity}
    </span>
  );
}

export function LevelBadge({ level }: { level: string | null }) {
  const l = (level ?? "").toLowerCase();
  const tone = l.includes("error") || l.includes("crit")
    ? "critical"
    : l.includes("warn")
      ? "warn"
      : "muted";
  return (
    <span className="text-xs" style={{ color: `var(--${tone})` }}>
      {level ?? "—"}
    </span>
  );
}

export function Card({
  label,
  value,
  tone = "accent",
  loading,
}: {
  label: string;
  value: string | number;
  tone?: string;
  loading?: boolean;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-line bg-surface p-4 transition duration-300 hover:-translate-y-0.5 hover:border-accent/40">
      <span
        className="absolute inset-x-0 top-0 h-px opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `linear-gradient(90deg, transparent, var(--${tone}), transparent)` }}
      />
      <p className="text-sm text-muted">{label}</p>
      <p
        className="mt-2 text-3xl font-semibold tabular-nums"
        style={{ color: `var(--${tone})` }}
      >
        {loading ? "…" : value}
      </p>
    </div>
  );
}

export function StatCard({
  label,
  value,
  tone = "accent",
  icon,
  hint,
  loading,
}: {
  label: string;
  value: string | number;
  tone?: string;
  icon?: React.ReactNode;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-line bg-surface p-5 transition duration-300 hover:-translate-y-0.5 hover:border-accent/30">
      {/* halo de couleur */}
      <div
        className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-[0.18] blur-2xl transition-opacity duration-300 group-hover:opacity-30"
        style={{ background: `var(--${tone})` }}
      />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted">{label}</p>
          <p
            className="mt-2 text-4xl font-semibold tabular-nums leading-none"
            style={{ color: `var(--${tone})` }}
          >
            {loading ? "…" : value}
          </p>
          {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
        </div>
        {icon && (
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
            style={{
              color: `var(--${tone})`,
              backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)`,
            }}
          >
            {icon}
          </span>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-40 place-items-center px-6 text-center text-sm text-muted">
      {children}
    </div>
  );
}

/** Répartition en barres horizontales (ex: événements par canal). */
export function BarList({ data, tone = "accent" }: { data: Record<string, number>; tone?: string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  if (entries.length === 0) return <EmptyState>Aucune donnée</EmptyState>;
  return (
    <div className="space-y-2 p-5">
      {entries.map(([key, val]) => (
        <div key={key} className="flex items-center gap-3 text-sm">
          <span className="w-40 shrink-0 truncate text-muted">{shortChannel(key)}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{ width: `${(val / max) * 100}%`, backgroundColor: `var(--${tone})` }}
            />
          </div>
          <span className="w-10 text-right font-mono tabular-nums">{val}</span>
        </div>
      ))}
    </div>
  );
}
