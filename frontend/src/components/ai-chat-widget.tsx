"use client";

import { useEffect, useRef, useState } from "react";
import { aiChat } from "@/lib/api";

interface Msg {
  role: "user" | "assistant";
  text: string;
  provider?: string;
}

const SUGGESTIONS = [
  "Quelles alertes critiques et pourquoi ?",
  "Résume les activités PowerShell suspectes.",
  "Quelles techniques MITRE détectées ?",
];

export function AiChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(q: string) {
    if (!q.trim() || loading) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setLoading(true);
    try {
      const res = await aiChat(q);
      setMessages((m) => [...m, { role: "assistant", text: res.answer, provider: res.provider }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: e instanceof Error ? e.message : "Erreur", provider: "builtin" }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Panneau */}
      <div
        className={`fixed bottom-24 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl transition-all duration-300 sm:right-6 ${
          open ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
        }`}
        style={{ height: "min(72dvh, 560px)" }}
      >
        <div className="flex items-center justify-between border-b border-line bg-surface-2/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent/15 text-accent">✦</span>
            <div>
              <p className="font-display text-sm font-semibold">Assistant SOC</p>
              <p className="eyebrow">DeTecTX · IA</p>
            </div>
          </div>
          <button onClick={() => setOpen(false)} className="text-muted transition hover:text-foreground">✕</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted">Pose une question sur tes alertes/événements.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}
                    className="rounded-full border border-line px-3 py-1.5 text-xs text-muted transition hover:border-accent/60 hover:text-accent">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((mm, i) => (
              <div key={i} className={`flex ${mm.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  mm.role === "user" ? "bg-accent text-accent-fg" : "border border-line bg-surface-2"
                }`}>
                  {mm.role === "assistant" && mm.provider && (
                    <span className="mb-1 block text-[10px] text-muted">
                      {mm.provider === "builtin" ? "Analyse intégrée" : `IA · ${mm.provider}`}
                    </span>
                  )}
                  {mm.text}
                </div>
              </div>
            ))
          )}
          {loading && <p className="text-sm text-muted">L’assistant réfléchit…</p>}
          <div ref={endRef} />
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex gap-2 border-t border-line p-3">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ta question…"
            className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent" />
          <button type="submit" disabled={loading}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50">
            →
          </button>
        </form>
      </div>

      {/* Bouton flottant */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Assistant IA"
        className="fixed bottom-6 right-4 z-50 grid h-14 w-14 place-items-center rounded-full bg-accent text-accent-fg shadow-xl transition hover:scale-105 sm:right-6"
        style={{ boxShadow: "0 0 0 1px rgba(var(--glow),0.4), 0 12px 30px -8px rgba(var(--glow),0.6)" }}
      >
        {open ? (
          <span className="text-xl">✕</span>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
        )}
      </button>
    </>
  );
}
