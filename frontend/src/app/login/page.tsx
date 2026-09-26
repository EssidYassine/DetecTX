"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login, register } from "@/lib/api";

type Mode = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      if (mode === "register") {
        await register(email, password);
        await login(email, password);
      } else {
        await login(email, password, otp || undefined);
      }
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de la connexion");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex flex-1 items-center justify-center px-4">
      <div className="soc-grid pointer-events-none absolute inset-0" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">
            De<span className="text-accent">Tec</span>TX
          </h1>
          <p className="mt-1 text-sm text-muted">
            Surveillance & détection de votre poste Windows
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface/80 p-6 shadow-2xl backdrop-blur">
          <div className="mb-5 grid grid-cols-2 rounded-lg bg-surface-2 p-1 text-sm">
            <button
              type="button"
              onClick={() => setMode("login")}
              className={`rounded-md py-1.5 font-medium transition ${
                mode === "login" ? "bg-accent text-accent-fg" : "text-muted hover:text-foreground"
              }`}
            >
              Se connecter
            </button>
            <button
              type="button"
              onClick={() => setMode("register")}
              className={`rounded-md py-1.5 font-medium transition ${
                mode === "register" ? "bg-accent text-accent-fg" : "text-muted hover:text-foreground"
              }`}
            >
              Créer un compte
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="vous@poste.local"
              autoComplete="email"
            />
            <Field
              label="Mot de passe"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder={mode === "register" ? "8 caractères minimum" : "••••••••"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
            {mode === "login" && (
              <Field
                label="Code MFA (si activé)"
                type="text"
                value={otp}
                onChange={setOtp}
                placeholder="000000"
                autoComplete="one-time-code"
                optional
              />
            )}

            {error && (
              <p className="rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
                {error}
              </p>
            )}
            {notice && (
              <p className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-accent py-2.5 font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50"
            >
              {loading
                ? "…"
                : mode === "register"
                  ? "Créer mon compte"
                  : "Accéder à mon poste"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-muted">
          Application locale mono-hôte — vos données ne quittent pas votre machine.
        </p>
      </div>
    </main>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  autoComplete,
  optional,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  optional?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={!optional}
        className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none transition placeholder:text-muted/50 focus:border-accent focus:ring-1 focus:ring-accent"
      />
    </label>
  );
}

function Logo() {
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden>
      <circle cx="26" cy="26" r="24" stroke="var(--line)" strokeWidth="2" />
      <circle cx="26" cy="26" r="15" stroke="var(--line)" strokeWidth="1.5" />
      <circle cx="26" cy="26" r="4" fill="var(--accent)" />
      <path
        d="M26 2 A24 24 0 0 1 50 26"
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <line x1="26" y1="26" x2="44" y2="14" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}
