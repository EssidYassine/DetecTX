"use client";

import { useRef, useState } from "react";
import { aiChat } from "@/lib/api";

interface Msg {
  role: "user" | "assistant";
  text: string;
  provider?: string;
}

const SUGGESTIONS = [
  "Quelles sont les alertes critiques et pourquoi ?",
  "Résume les activités PowerShell suspectes.",
  "Quelles techniques MITRE ont été détectées ?",
];

export default function AiAssistantPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function send(question: string) {
    if (!question.trim() || loading) return;
    setMessages((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setLoading(true);
    try {
      const res = await aiChat(question);
      setMessages((m) => [...m, { role: "assistant", text: res.answer, provider: res.provider }]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: e instanceof Error ? e.message : "Erreur", provider: "builtin" },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] flex-col">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Assistant SOC</h1>
        <p className="text-sm text-muted">
          Posez des questions sur vos alertes et événements — l’IA répond à partir de votre contexte.
        </p>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-line bg-surface p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-muted">Aucune conversation. Essayez une question :</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-line px-3 py-1.5 text-sm text-muted transition hover:border-accent/60 hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-accent text-accent-fg"
                    : "border border-line bg-surface-2"
                }`}
              >
                {m.role === "assistant" && m.provider && (
                  <span className="mb-1 block text-xs text-muted">
                    {m.provider === "builtin" ? "Analyse intégrée" : `IA · ${m.provider}`}
                  </span>
                )}
                {m.text}
              </div>
            </div>
          ))
        )}
        {loading && <p className="text-sm text-muted">L’assistant réfléchit…</p>}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="mt-4 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Posez votre question SOC…"
          className="flex-1 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50"
        >
          Envoyer
        </button>
      </form>
    </div>
  );
}
