"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import NavTabs from "./_components/NavTabs";
import BrandMark from "./_components/BrandMark";
import { getMetricsForDisplay, resolveOverallPercent } from "../lib/evalMetrics.mjs";

const TARGET_MODELS = ["ChatGPT", "Claude", "Gemini", "Grok"];
const STEPS = [
  { id: 1, label: "Intent" },
  { id: 2, label: "Clarification" },
  { id: 3, label: "Result" },
];

// ───────────────────────────────────────────────────────────────────────────
// Parse the structured output from the orchestrate API into its four parts.
// The response embeds <thinking>, <context_grounding>, ### PROMPT START/END,
// and <eval_prediction>. Tolerates partial/unclosed regions so the parser
// works while tokens are still streaming in (e.g. <thinking> opened but not
// yet closed, or ### PROMPT START emitted but END not yet reached).
// ───────────────────────────────────────────────────────────────────────────
function parseStructuredOutput(raw) {
  if (!raw) return { thinking: "", grounding: "", prompt: "", evalPrediction: "" };

  // Open-tolerant extractor: match the opening tag, then everything up to
  // the closing tag OR end-of-stream. Works for both final and streaming text.
  const openTag = (name) => {
    const re = new RegExp(`<${name}>([\\s\\S]*?)(?:<\\/${name}>|$)`, "i");
    const m = raw.match(re);
    return m ? m[1].trim() : "";
  };

  const bodyMatch = raw.match(/### PROMPT START\s*([\s\S]*?)(?:\s*### PROMPT END|$)/i);
  // While streaming, if ### PROMPT START hasn't arrived yet, prompt is empty
  // (the text so far belongs to <thinking> or <context_grounding>).
  const hasPromptStart = /### PROMPT START/i.test(raw);

  return {
    thinking: openTag("thinking"),
    grounding: openTag("context_grounding"),
    evalPrediction: openTag("eval_prediction"),
    prompt: hasPromptStart && bodyMatch ? bodyMatch[1].trim() : "",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════════════════

export default function Home() {
  const [step, setStep] = useState(1);
  const [intent, setIntent] = useState("");
  const [targetModel, setTargetModel] = useState(TARGET_MODELS[0]);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState([]);
  const [clarityScore, setClarityScore] = useState(null);
  // clarifyRound counts how many times the backend has asked for more info.
  // Incremented whenever a new set of questions arrives; drives the
  // "Follow-up Questions (Round N)" label and keys the fade-in transition.
  const [clarifyRound, setClarifyRound] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [powerMode, setPowerMode] = useState(false);
  const [copied, setCopied] = useState(false);

  // Split-state for the structured output. Both are derived from the same
  // stream, parsed incrementally: while the model is still inside <thinking>,
  // only thinkingContent grows. Once ### PROMPT START is emitted, subsequent
  // tokens start filling optimizedPrompt instead.
  const [thinkingContent, setThinkingContent] = useState("");
  const [optimizedPrompt, setOptimizedPrompt] = useState("");

  // Eval Layer V1 is non-streaming: instead of token deltas, the server emits
  // coarse `stage` events. This holds the current human-readable stage label
  // (e.g. "Evaluating optimization quality…") shown while we await the final
  // prompt. Empty string = no active stage.
  const [loadingStage, setLoadingStage] = useState("");

  // React 19: async callbacks inside startTransition keep the UI responsive
  // without needing a manual isLoading flag.
  const [isPending, startTransition] = useTransition();

  // Refs for focus management + auto-scroll.
  const intentRef = useRef(null);      // <textarea> on step 1 — focused on "Start over"
  const resultRef = useRef(null);      // Improved Prompt panel — scrolled into view on generation
  const didAutoScrollRef = useRef(false); // one-shot guard so we don't re-scroll on every token
  const returnToIntentRef = useRef(false); // set by handleStartOver, consumed by useEffect below
  // Controller for the in-flight /api/orchestrate fetch. We abort it on:
  //   - Start Over      → user doesn't care about the current run
  //   - unmount          → user navigated away (prevents paid token burn)
  //   - starting a new run → callApi() replaces any existing controller
  // Without this, a user who hits Start Over mid-generation keeps the server
  // streaming tokens to /dev/null — we pay Together AI for output nobody sees.
  const abortRef = useRef(null);

  // Transient "generation complete" flag — drives a fade-out border pulse.
  const [justCompleted, setJustCompleted] = useState(false);

  // Auto-scroll the result panel into view as soon as Step 3 mounts — the
  // user should see the generation affordance immediately, not wait for the
  // first token. Gated by didAutoScrollRef so mid-stream re-renders don't
  // hijack the scroll position while the user is reading.
  useEffect(() => {
    if (step === 3 && !didAutoScrollRef.current) {
      // rAF lets the result DOM node mount + layout before we measure it.
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      didAutoScrollRef.current = true;
    }
  }, [step]);

  // When a stream finishes (streaming: true → false), flash a border pulse.
  const wasStreaming = useRef(false);
  useEffect(() => {
    const streaming = Boolean(result?.streaming);
    if (wasStreaming.current && !streaming && optimizedPrompt) {
      setJustCompleted(true);
      const t = setTimeout(() => setJustCompleted(false), 1500);
      return () => clearTimeout(t);
    }
    wasStreaming.current = streaming;
  }, [result?.streaming, optimizedPrompt]);

  // After "Start over" returns to step 1, focus the intent textarea so
  // the user can immediately begin typing their next iteration.
  useEffect(() => {
    if (step === 1 && returnToIntentRef.current) {
      returnToIntentRef.current = false;
      // requestAnimationFrame gives the form a tick to mount before focus.
      requestAnimationFrame(() => intentRef.current?.focus());
    }
  }, [step]);

  // Kill any in-flight fetch when the component unmounts (user navigates to
  // /vault, closes the tab, etc.) so the server stops streaming to a client
  // that will never read the response.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Streaming NDJSON reader. The server emits one event per line:
  //   clarifying | cached | meta | token | done | error
  // We update state incrementally so the optimized prompt renders as it is
  // generated, not after the full synthesis completes.
  async function callApi(userInput, { skipClarification = false } = {}) {
    // Abort any in-flight request from a previous run before starting a new
    // one. The signal is passed to fetch, so the browser tears down the TCP
    // stream and Node's ReadableStream errors on the server, which ends the
    // Together AI streaming loop early.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError("");
    setResult(null); // clear prior run — critical so stale optimized prompt
                     //                   doesn't flash while we await clarifying
    setThinkingContent("");
    setOptimizedPrompt("");
    setLoadingStage("");
    setCopied(false);
    setJustCompleted(false);
    didAutoScrollRef.current = false; // re-arm auto-scroll for this run

    let res;
    try {
      res = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userInput, targetModel, skipClarification }),
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError is expected whenever the user starts over / unmounts — it
      // isn't a real error, so we swallow it silently. Anything else gets
      // surfaced.
      if (err.name === "AbortError") return;
      setError("Network error. Please check your connection and try again.");
      return;
    }
    if (!res.ok || !res.body) {
      // Try to surface the server's user-friendly error message (set by the
      // validators / rate limiter). Fall back to a generic string on parse
      // failure so we never block the UI.
      let serverMsg = null;
      try {
        const errBody = await res.json();
        serverMsg = errBody?.error ?? null;
      } catch { /* not JSON — ignore */ }
      setError(serverMsg || `Request failed (${res.status})`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Updates the split output states from a raw structured-output buffer.
    // Called on the final `done`/`cached` events to render the parsed prompt.
    const syncSplitStates = (raw) => {
      const p = parseStructuredOutput(raw);
      setThinkingContent(p.thinking);
      setOptimizedPrompt(p.prompt);
    };

    const applyEvent = (ev) => {
      switch (ev.type) {
        case "clarifying":
          setResult(null);
          setThinkingContent("");
          setOptimizedPrompt("");
          setLoadingStage("");
          setQuestions(ev.questions ?? []);
          setAnswers(new Array(ev.questions?.length ?? 0).fill(""));
          setClarityScore(ev.clarityScore ?? null);
          setClarifyRound((r) => r + 1);
          setStep(2);
          break;
        case "cached":
          setResult(ev);
          syncSplitStates(ev.optimizedPrompt ?? "");
          setClarityScore(ev.clarityScore ?? null);
          setLoadingStage("");
          setStep(3);
          break;
        case "stage":
          // Non-streaming progress. Move to step 3 and ensure a result object
          // exists so the result panel renders its loading state — even before
          // the `meta` event populates RAG sources.
          setLoadingStage(ev.label ?? "");
          setResult((prev) => prev ?? { streaming: true, ragSources: [] });
          setStep(3);
          break;
        case "meta":
          metaPayload = ev;
          setResult({ ...ev, optimizedPrompt: "", streaming: true });
          setClarityScore(ev.clarityScore ?? null);
          setStep(3);
          break;
        case "done":
          // The server already selected the final prompt (V1 or refined V2);
          // `optimizedPrompt` carries it for the structured-output parser.
          setResult({ ...ev, streaming: false });
          syncSplitStates(ev.optimizedPrompt ?? ev.finalPrompt ?? "");
          setLoadingStage("");
          break;
        case "error":
          setError(ev.error || "Stream error");
          setLoadingStage("");
          break;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            applyEvent(JSON.parse(trimmed));
          } catch {
            // malformed line — skip, keep stream alive
          }
        }
      }
    } catch (err) {
      // Aborted by Start Over / unmount — expected, not an error. Anything
      // else is a real network hiccup mid-stream.
      if (err.name !== "AbortError") {
        setError("Stream interrupted. Please try again.");
      }
    } finally {
      // Only clear the ref if it's still ours — callApi() may have already
      // been called again and installed a new controller.
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function handleStep1Submit(e) {
    e.preventDefault();
    if (!intent.trim()) return;
    startTransition(() => callApi(intent.trim()));
  }

  // Build the enriched prompt from whatever answers the user has filled in.
  // Blank answers are permitted — they become "(not specified)" so the model
  // knows the user explicitly declined rather than forgot.
  function buildEnrichedInput() {
    return (
      `${intent.trim()}\n\n--- Additional context ---\n` +
      questions
        .map((q, i) => `Q: ${q}\nA: ${(answers[i] ?? "").trim() || "(not specified)"}`)
        .join("\n\n")
    );
  }

  function handleStep2Submit(e) {
    e.preventDefault();
    // skipClarification=true unconditionally on re-submit: the user has now
    // seen the questions and chosen to proceed, even with partial answers.
    // Prevents the server from looping back into another clarifying round.
    startTransition(() => callApi(buildEnrichedInput(), { skipClarification: true }));
  }

  function handleStep2Skip() {
    // "Skip & Generate" — bypass the questions entirely. We send ONLY the
    // original raw intent (no Q/A appendix), telling the orchestrator to
    // proceed straight to synthesis without another clarification round.
    // This differs from Continue, which sends the user's filled-in answers.
    startTransition(() =>
      callApi(intent.trim(), { skipClarification: true })
    );
  }

  function handleStartOver() {
    // Kill any in-flight generation so we stop paying for tokens the user
    // will never see.
    abortRef.current?.abort();
    abortRef.current = null;
    returnToIntentRef.current = true; // consumed by useEffect on [step]
    setStep(1);
    setQuestions([]);
    setAnswers([]);
    setResult(null);
    setThinkingContent("");
    setOptimizedPrompt("");
    setLoadingStage("");
    setError("");
    setClarityScore(null);
    setClarifyRound(0);
    setCopied(false);
    setJustCompleted(false);
    didAutoScrollRef.current = false;
  }

  // `parsed` still surfaces grounding + evalPrediction for the reasoning box.
  // The optimized prompt and thinking content live in their own states so
  // they can update independently during streaming.
  const parsed = useMemo(
    () => parseStructuredOutput(result?.optimizedPrompt ?? ""),
    [result]
  );

  async function handleCopy() {
    if (!optimizedPrompt) return;
    try {
      await navigator.clipboard.writeText(optimizedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard denied — silent */ }
  }

  // "Agentic process is active" whenever we're waiting on the server —
  // either the fetch is in-flight (isPending) or we're streaming tokens.
  // Drives the pulse on both the navbar brand-mark and the hero logo.
  const isRefining = isPending || Boolean(result?.streaming);

  return (
    <div className="min-h-screen text-text">
      <Header
        powerMode={powerMode}
        setPowerMode={setPowerMode}
        isRefining={isRefining}
      />

      {/* ── Hero ──────────────────────────────────────────────────────────
          Type scale + top padding mirror the Knowledge Vault hero exactly
          so switching tabs doesn't cause vertical jump. Title is clean
          white; subtitle carries the purple accent for focus. */}
      <section className="mx-auto w-full max-w-2xl px-6 pt-10 pb-4 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-text sm:text-4xl">
          Expert-Quality LLM Output
        </h1>
        <p className="mt-3 text-lg leading-relaxed text-accent-2">
          For non-technical professionals — without learning prompt engineering.
        </p>
      </section>

      <main
        className={`mx-auto w-full max-w-[1280px] px-6 pb-20 pt-6 grid gap-8 transition-[grid-template-columns] duration-300 ease-out ${
          powerMode ? "grid-cols-1 lg:grid-cols-[1fr_350px]" : "grid-cols-1"
        }`}
      >
        {/* ── Wizard column ───────────────────────────────────────────── */}
        <section className="min-w-0">
          <Stepper currentStep={step} />

          <div className="mt-8 rounded-2xl border border-border bg-surface/80 backdrop-blur-sm shadow-[0_20px_60px_-20px_rgba(0,0,0,0.6)]">
            {error && (
              <div
                role="alert"
                className="mx-6 mt-6 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
              >
                {error}
              </div>
            )}

            {step === 1 && (
              <StepIntent
                intentRef={intentRef}
                intent={intent}
                setIntent={setIntent}
                targetModel={targetModel}
                setTargetModel={setTargetModel}
                onSubmit={handleStep1Submit}
                isPending={isPending}
              />
            )}

            {step === 2 && (
              <StepClarification
                round={clarifyRound}
                questions={questions}
                answers={answers}
                setAnswers={setAnswers}
                clarityScore={clarityScore}
                onSubmit={handleStep2Submit}
                onSkip={handleStep2Skip}
                onBack={() => setStep(1)}
                isPending={isPending}
              />
            )}

            {step === 3 && (
              <StepResult
                resultRef={resultRef}
                justCompleted={justCompleted}
                thinkingContent={thinkingContent}
                optimizedPrompt={optimizedPrompt}
                loadingStage={loadingStage}
                parsed={parsed}
                result={result}
                targetModel={targetModel}
                copied={copied}
                onCopy={handleCopy}
                onStartOver={handleStartOver}
                powerMode={powerMode}
              />
            )}
          </div>
        </section>

        {/* ── Power panel ─────────────────────────────────────────────── */}
        {powerMode && (
          <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start animate-[fadeIn_300ms_ease-out]">
            <CacheStatusCard result={result} />
            <QualityDashboard result={result} />
            <RagSourcesCard result={result} />
          </aside>
        )}
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Header
// ═══════════════════════════════════════════════════════════════════════════

function Header({ powerMode, setPowerMode, isRefining }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-3" aria-label="PromptPilot home">
            {/* Logo pulses softly whenever an agentic run is active, so
                even the navbar signals that work is in flight. The wordmark
                already contains the "PromptPilot" text — see BrandMark — so we
                must NOT add a separate text label here (avoids "PromptPilot
                PromptPilot" and frees header width on mobile). */}
            <BrandMark height={36} loading={isRefining} priority />
          </Link>
          <div className="hidden sm:block">
            <NavTabs />
          </div>
        </div>

        <PowerToggle enabled={powerMode} onChange={setPowerMode} />
      </div>
    </header>
  );
}

function PowerToggle({ enabled, onChange }) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className="group flex items-center gap-3 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-sm transition hover:border-accent/50"
    >
      <span className="flex items-center gap-1.5 font-medium">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={enabled ? "text-accent" : "text-text-dim"}
        >
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        <span className={enabled ? "text-text" : "text-text-muted"}>Power Mode</span>
      </span>
      {/* Track: h-6 w-12 rounded-full. Knob: h-5 w-5 with p-0.5 padding, so
          on-state translates by exactly track_w − knob_w − 2·padding = 48 − 20 − 4 = 24px
          (= Tailwind translate-x-6), landing flush inside the right edge. */}
      <span
        className={`relative inline-flex h-6 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ${
          enabled ? "bg-accent" : "bg-border-2"
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-out ${
            enabled ? "translate-x-6" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Stepper
// ═══════════════════════════════════════════════════════════════════════════

function Stepper({ currentStep }) {
  return (
    <ol className="flex items-center gap-3">
      {STEPS.map((s, idx) => {
        const state =
          s.id === currentStep ? "active" : s.id < currentStep ? "done" : "upcoming";
        return (
          <li key={s.id} className="flex flex-1 items-center gap-3 min-w-0">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold transition ${
                state === "active"
                  ? "border-accent bg-accent text-white animate-[pulse-ring_1.6s_ease-out_infinite]"
                  : state === "done"
                  ? "border-accent/60 bg-accent/15 text-accent"
                  : "border-border-2 bg-surface text-text-dim"
              }`}
            >
              {state === "done" ? "✓" : s.id}
            </div>
            <span
              className={`min-w-0 truncate text-[13px] font-medium tracking-wide ${
                state === "upcoming" ? "text-text-dim" : "text-text"
              }`}
            >
              {s.label}
            </span>
            {idx < STEPS.length - 1 && (
              <div
                className={`h-px flex-1 ${
                  state === "done" ? "bg-accent/50" : "bg-border"
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 1 — Intent
// ═══════════════════════════════════════════════════════════════════════════

function StepIntent({ intentRef, intent, setIntent, targetModel, setTargetModel, onSubmit, isPending }) {
  return (
    <form onSubmit={onSubmit} className="p-6 sm:p-8">
      <h2 className="text-lg font-semibold text-text">What are you trying to do?</h2>
      <p className="mt-1 text-sm text-text-muted">
        Describe your raw intent in plain language — we'll analyse clarity and either ask you
        to sharpen it or produce a production-ready prompt.
      </p>

      <textarea
        ref={intentRef}
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        rows={8}
        placeholder="e.g. Help me write a weekly update email to engineering leadership summarising our sprint outcomes…"
        className="mt-5 w-full resize-y rounded-xl border border-border bg-surface-2 px-4 py-3.5 text-[14px] leading-relaxed text-text placeholder:text-text-dim outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
      />

      <div className="mt-5 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <label htmlFor="tm" className="text-[13px] font-medium text-text-muted">
            Target model
          </label>
          <select
            id="tm"
            value={targetModel}
            onChange={(e) => setTargetModel(e.target.value)}
            className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-[13px] text-text outline-none transition hover:border-border-2 focus:border-accent/60"
          >
            {TARGET_MODELS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={!intent.trim() || isPending}
          className="group relative inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-accent to-accent-2 px-6 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_-8px_rgba(124,58,237,0.6)] transition hover:shadow-[0_12px_32px_-8px_rgba(124,58,237,0.8)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        >
          {isPending ? <Spinner /> : null}
          {isPending ? "Analysing intent…" : "Continue →"}
        </button>
      </div>
    </form>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 2 — Clarification
// ═══════════════════════════════════════════════════════════════════════════

function StepClarification({
  round, questions, answers, setAnswers, clarityScore, onSubmit, onSkip, onBack, isPending,
}) {
  function updateAnswer(i, value) {
    setAnswers((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  }

  return (
    <form onSubmit={onSubmit} className="p-6 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-accent-2">
            <span>Follow-up Questions</span>
            {round > 0 && (
              <span className="rounded-md bg-accent-2/15 px-1.5 py-0.5 font-mono text-[10px] text-accent-2">
                Round {round}
              </span>
            )}
          </div>
          <h2 className="text-lg font-semibold text-text">Help us sharpen this</h2>
          <p className="mt-1 text-sm text-text-muted">
            Answer what you can — skip anything you're unsure about and we'll
            generate your prompt with the detail you have.
          </p>
        </div>
        {typeof clarityScore === "number" && (
          <div className="shrink-0 rounded-lg border border-border bg-surface-2 px-3 py-2 text-right">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
              Clarity
            </div>
            <div className="text-base font-semibold text-warning">
              {(clarityScore * 100).toFixed(0)}%
            </div>
          </div>
        )}
      </div>

      {/* Keying on `round` remounts the question list whenever a new round
          arrives, re-triggering the staggered slide/fade animation so users
          get a clear visual signal that fresh questions have loaded. */}
      <div key={round} className="mt-6 space-y-4">
        {questions.map((q, i) => (
          <div
            key={i}
            className="rounded-xl border border-border bg-surface-2/60 p-4"
            style={{ animation: `fadeIn 300ms ease-out ${i * 80}ms both` }}
          >
            <label
              htmlFor={`a-${i}`}
              className="flex items-start gap-2 text-[14px] font-medium text-text"
            >
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/20 text-[11px] font-bold text-accent">
                {i + 1}
              </span>
              <span>{q}</span>
            </label>
            <textarea
              id={`a-${i}`}
              value={answers[i] ?? ""}
              onChange={(e) => updateAnswer(i, e.target.value)}
              rows={2}
              placeholder="Your answer (optional)…"
              className="mt-3 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-dim outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
            />
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          className="rounded-xl border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text-muted transition hover:border-border-2 hover:text-text disabled:opacity-40"
        >
          ← Back
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {/* Ghost-styled secondary action: transparent bg, no border until
              hover. Intentionally low-weight so it doesn't compete with the
              primary "Generate prompt" CTA to its right. */}
          <button
            type="button"
            onClick={onSkip}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-xl border border-transparent bg-transparent px-4 py-2.5 text-sm font-medium text-text-dim transition hover:border-border hover:bg-surface-2/60 hover:text-text-muted disabled:cursor-not-allowed disabled:opacity-40"
            title="Generate now without answering the questions"
          >
            Skip &amp; Generate with current info
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-accent to-accent-2 px-6 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_-8px_rgba(124,58,237,0.6)] transition hover:shadow-[0_12px_32px_-8px_rgba(124,58,237,0.8)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPending ? <Spinner /> : null}
            {isPending ? "Synthesising…" : "Generate prompt →"}
          </button>
        </div>
      </div>
    </form>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 3 — Result
// ═══════════════════════════════════════════════════════════════════════════

function StepResult({
  resultRef,
  justCompleted,
  thinkingContent,
  optimizedPrompt,
  loadingStage,
  parsed,
  result,
  targetModel,
  copied,
  onCopy,
  onStartOver,
  powerMode,
}) {
  const streaming = result?.streaming;
  // Thinking has arrived if either thinkingContent or any other reasoning
  // region has non-empty text. Reasoning is parsed only once the final prompt
  // lands (Eval Layer V1 is non-streaming), so we gate purely on content.
  const hasReasoning =
    Boolean(thinkingContent) || Boolean(parsed.grounding) || Boolean(parsed.evalPrediction);

  // Loading phase: the server is buffering V1 → judge → optional refinement.
  // No prompt is shown until `done`; we render a staged skeleton meanwhile.
  const loading = streaming && !optimizedPrompt;

  return (
    <div className="p-6 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text">Your production-ready prompt</h2>
          <p className="mt-1 text-sm text-text-muted">
            Optimized for <span className="text-accent-2 font-medium">{targetModel}</span>
            {result?.cacheHit && (
              <span className="ml-2 rounded-md bg-success/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success">
                Cached
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onCopy}
            disabled={!optimizedPrompt}
            className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-accent transition hover:bg-accent/20 disabled:opacity-40"
          >
            {copied ? "✓ Copied" : "Copy prompt"}
          </button>
          <button
            onClick={onStartOver}
            className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-text-muted transition hover:border-border-2 hover:text-text"
          >
            Start over
          </button>
        </div>
      </div>

      {/* Reasoning — Power Mode only, collapsed by default via <details>.
          Browser-native progressive disclosure: no JS state, no layout glue.
          The summary acts as the toggle button; chevron rotates on open. */}
      {powerMode && hasReasoning && (
        <ReasoningDisclosure
          thinking={thinkingContent}
          grounding={parsed.grounding}
          evalPrediction={parsed.evalPrediction}
          showCursor={false}
        />
      )}

      {/* Improved prompt — high-contrast block.
          Uses flex + p-0 so the Research Blueprint footer can live inside
          with its own padding, a top border, and a distinct muted bg.
          `justCompleted` adds a brief ring/shadow that fades out to signal
          that the stream has finished — transition-[box-shadow,border-color]
          drives the fade without a JS animation loop. */}
      <div
        ref={resultRef}
        className={`mt-5 flex flex-col overflow-hidden rounded-xl border bg-gradient-to-br from-accent/[0.06] to-transparent transition-[box-shadow,border-color] duration-1000 ease-out ${
          justCompleted
            ? "border-accent/70 shadow-[0_0_0_3px_rgba(168,85,247,0.35),0_10px_40px_-20px_rgba(124,58,237,0.6)]"
            : "border-accent/30 shadow-[0_10px_40px_-20px_rgba(124,58,237,0.6)]"
        }`}
      >
        <div className="p-5">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-accent-2">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>Improved Prompt</span>
          </div>
          {/* Eval Layer V1 is non-streaming: nothing is shown until the final
              prompt lands. While the orchestration runs (optimize → evaluate →
              refine) we show a shimmer skeleton driven by the server's current
              stage label, in BOTH Power Mode and standard mode. */}
          {loading ? (
            <GeneratingSkeleton label={loadingStage} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-text">
              {optimizedPrompt}
              {!optimizedPrompt && !streaming && (
                <span className="text-text-dim italic">No prompt returned.</span>
              )}
            </pre>
          )}
        </div>

        <ResearchBlueprintFooter sources={result?.ragSources ?? []} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Reasoning Disclosure — Power Mode only. Native <details> for progressive
// disclosure (no JS state). Closed by default. The summary is styled as a
// professional, clickable button with a chevron that rotates 90° when open.
//
// The `group` class on <details> + `[details[open]]` / `details[open] &`
// selectors are Tailwind v4 arbitrary-variant tricks we *could* use, but a
// simple `open:rotate-90` on the chevron via `group-open:` works in all
// current Tailwind versions and stays readable.
// ═══════════════════════════════════════════════════════════════════════════

function ReasoningDisclosure({ thinking, grounding, evalPrediction, showCursor }) {
  return (
    <details
      className="group mt-5 overflow-hidden rounded-xl border border-border bg-surface-2/30 transition-colors open:bg-surface-2/50"
      // open={false} is the default for <details>; stated explicitly to
      // satisfy the "collapsed by default" requirement and so future
      // refactors don't accidentally flip it.
      open={false}
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[12px] font-medium text-text-muted transition hover:bg-surface-2/70 hover:text-text [&::-webkit-details-marker]:hidden"
        aria-label="Toggle reasoning process"
      >
        <span className="flex items-center gap-2">
          <BrainIcon />
          <span className="uppercase tracking-[0.14em] text-[11px] font-bold text-text-dim group-open:text-accent-2">
            View Reasoning Process
          </span>
          {showCursor && (
            <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-2" />
          )}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-text-dim transition-transform duration-200 ease-out group-open:rotate-90 group-open:text-accent-2"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </summary>

      <div className="space-y-3 border-t border-border/60 px-4 py-4 text-text-muted animate-[fadeIn_180ms_ease-out]">
        {thinking && <ReasoningBlock label="Thinking" body={thinking} />}
        {grounding && <ReasoningBlock label="Context Grounding" body={grounding} />}
        {evalPrediction && (
          <ReasoningBlock label="Eval Prediction" body={evalPrediction} />
        )}
        {!thinking && !grounding && !evalPrediction && showCursor && (
          <div className="text-[12px] italic text-text-dim">Thinking…</div>
        )}
      </div>
    </details>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Generating Skeleton — Power-Mode-off loader. Without the Reasoning panel
// there's no visible feedback during the <thinking> phase, so we show a
// rotating status line ("Analysing intent → Retrieving research → …") plus
// shimmering placeholder bars that hint at the prompt's shape. The status
// phrase advances on a timer; a11y: aria-live announces each phase for
// screen readers. Bars use the Tailwind `animate-pulse` utility with
// staggered opacity via per-bar delay for a wave effect.
// ═══════════════════════════════════════════════════════════════════════════

function GeneratingSkeleton({ label = "" }) {
  // Fallback cycle for paths that don't drive an explicit stage label.
  const PHASES = [
    "Analysing intent…",
    "Retrieving research…",
    "Synthesising prompt…",
    "Polishing output…",
  ];
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    // When the server is driving the label, don't run the local cycle.
    if (label) return;
    const id = setInterval(() => setPhase((p) => (p + 1) % PHASES.length), 1400);
    return () => clearInterval(id);
  }, [label]);

  // Elapsed-time tracker → reassurance affordance. Slow runs (judge + refine
  // can push past 30s) otherwise look stalled; after a threshold we swap the
  // caption to an explicit "still working" message so the wait reads as
  // intentional, not hung.
  const SLOW_AFTER_SEC = 30;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const takingLong = elapsed >= SLOW_AFTER_SEC;

  // Server-driven stage label takes precedence over the local fallback cycle.
  const statusText = label || PHASES[phase];

  // Bar widths are deliberately irregular so the block reads as prose-like
  // text rather than a table. All bars use `animate-pulse`; staggered
  // `animationDelay` produces a left-to-right shimmer wave.
  const bars = [
    "w-[92%]", "w-[78%]", "w-[85%]",
    "w-[68%]", "w-[88%]", "w-[55%]",
  ];

  return (
    <div aria-live="polite" aria-busy="true">
      <div className="flex items-center gap-2.5 text-[12px] font-medium text-accent-2">
        <span
          className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-accent-2/30 border-t-accent-2 animate-spin"
          aria-hidden="true"
        />
        <span key={statusText} className="animate-[fadeIn_260ms_ease-out]">
          {statusText}
        </span>
      </div>

      <div className="mt-4 space-y-2.5">
        {bars.map((w, i) => (
          <div
            key={i}
            className={`h-3 rounded-md bg-gradient-to-r from-accent/15 via-accent-2/25 to-accent/15 animate-pulse ${w}`}
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>

      <p
        className={`mt-4 text-[11px] italic transition-colors ${
          takingLong ? "text-accent-2 not-italic" : "text-text-dim"
        }`}
      >
        {takingLong
          ? "Still working — quality checks are taking a little longer than usual. Hang tight, your prompt is on its way."
          : "Grounding, evaluating, and refining your prompt — this can take up to a minute."}
      </p>
    </div>
  );
}

function BrainIcon() {
  // Simple "spark" glyph — legible at 12px and reads as reasoning/ideation.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-accent-2"
    >
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="M4.93 4.93l2.83 2.83" />
      <path d="M16.24 16.24l2.83 2.83" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
      <path d="M4.93 19.07l2.83-2.83" />
      <path d="M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Research Blueprint — footer inside the Optimized Prompt panel. Renders
// citations as interactive chips. A top border + subtle indigo/accent tint
// separates it visually from the prompt text above.
// ═══════════════════════════════════════════════════════════════════════════

function ResearchBlueprintFooter({ sources }) {
  return (
    <div className="border-t border-accent/20 bg-accent/[0.04] px-5 py-4">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-text-dim">
        <BlueprintIcon />
        <span>Research Blueprint</span>
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
          {sources.length}
        </span>
      </div>

      {sources.length === 0 ? (
        <div className="mt-2.5 text-[12px] text-text-dim">
          No research grounded this prompt — relying on built-in best practices.
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {sources.map((s, i) => (
            <CitationChip key={i} index={i + 1} source={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function CitationChip({ index, source }) {
  const Tag = source.citation_url ? "a" : "div";
  const linkProps = source.citation_url
    ? { href: source.citation_url, target: "_blank", rel: "noopener noreferrer" }
    : {};
  return (
    <Tag
      {...linkProps}
      className={`group inline-flex max-w-full items-center gap-2 rounded-full border border-accent/30 bg-surface/70 px-3 py-1 text-[12px] text-text transition ${
        source.citation_url
          ? "cursor-pointer hover:border-accent/60 hover:bg-accent/15 hover:text-accent"
          : "cursor-default"
      }`}
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/25 font-mono text-[10px] font-bold text-accent">
        {index}
      </span>
      <span className="min-w-0 truncate font-medium">{source.title}</span>
      {source.citation_url && (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-text-dim transition group-hover:text-accent"
          aria-hidden="true"
        >
          <path d="M7 17 17 7" />
          <path d="M8 7h9v9" />
        </svg>
      )}
    </Tag>
  );
}

function BlueprintIcon() {
  // Grid/blueprint glyph — hints at the "underlying architecture" metaphor.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-accent-2"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 3v18" />
    </svg>
  );
}

function ReasoningBlock({ label, body }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-accent-2">
        {label}
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-muted">
        {body}
      </pre>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Power Panel — right side
// ═══════════════════════════════════════════════════════════════════════════

function CacheStatusCard({ result }) {
  // While the pipeline is running, `result.streaming` is true but the cache
  // outcome isn't known yet — don't flash "Miss" prematurely.
  const working = result?.streaming === true;
  const hit = result?.cacheHit === true;
  const miss = Boolean(result) && !hit && !working;
  const idle = !result;
  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-dim">
          Redis Cache
        </div>
        <div
          className={`rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
            hit
              ? "bg-success/15 text-success"
              : miss
              ? "bg-warning/15 text-warning"
              : "bg-border-2/40 text-text-dim"
          }`}
        >
          {working ? "···" : idle ? "Idle" : hit ? "Hit" : "Miss"}
        </div>
      </div>

      <div className="mt-3 text-[13px] text-text-muted">
        {working && "Checking cache & synthesising…"}
        {!working && idle && "Awaiting first query…"}
        {miss && "Fresh synthesis. Cached for 24 h for similar prompts."}
        {hit && (
          <>
            Served from cache at{" "}
            <span className="font-semibold text-success">
              {(result.cacheSimilarity * 100).toFixed(1)}%
            </span>{" "}
            similarity.
          </>
        )}
      </div>
    </div>
  );
}

function QualityDashboard({ result }) {
  // Prefer the GPT-5-mini judge scores (evaluationResult) when present. The
  // judge grades every metric on 0–10 and `overall` on 0–100. When the judge was
  // disabled or failed, fall back to the legacy lexical faithfulness + mean-cosine
  // relevancy so the dashboard still renders meaningfully (and stays back-compatible
  // with cached payloads generated before the eval layer / before the new metrics).
  const evalResult =
    result?.evaluationResult && result.evaluationResult.evaluation_failed === false
      ? result.evaluationResult
      : null;
  const judged = Boolean(evalResult);

  const cosineRelevancy = useMemo(() => {
    if (!result?.ragSources?.length) return null;
    return (
      result.ragSources.reduce((s, src) => s + (src.similarity ?? 0), 0) /
      result.ragSources.length
    );
  }, [result]);

  // View-model: one entry per metric, score on 0–10 or null. getMetricsForDisplay
  // never throws and yields null scores for metrics absent from an old payload —
  // the card then renders "—" instead of crashing.
  const metrics = useMemo(() => {
    const base = getMetricsForDisplay(evalResult);
    if (judged) return base;
    // Not judged → backfill the two legacy metrics from the Ragas fallback
    // (0–1 → 0–10). The three newer metrics stay null ("—").
    const fallback = {
      intentFidelity: result?.faithfulnessScore,
      techniquePreservation: cosineRelevancy,
    };
    return base.map((m) =>
      fallback[m.key] != null ? { ...m, score: fallback[m.key] * 10 } : m
    );
  }, [evalResult, judged, result?.faithfulnessScore, cosineRelevancy]);

  // Headline composite (0–100): weighted composite → judge overall → legacy mean.
  const overallPct = useMemo(() => {
    if (judged) return resolveOverallPercent(evalResult);
    const f = result?.faithfulnessScore;
    const r = cosineRelevancy;
    return resolveOverallPercent(null, { faithfulness: f, relevancy: r });
  }, [judged, evalResult, result?.faithfulnessScore, cosineRelevancy]);

  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-dim">
          Quality Dashboard
        </div>
        <div className="text-[11px] font-medium text-text-dim">
          {judged ? "GPT-5-mini judge" : "Ragas"}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {metrics.map((m) => (
          <MetricCard key={m.key} metric={m} />
        ))}

        <div className="mt-3 flex items-center justify-between rounded-lg border border-border-2/60 bg-surface-2/60 px-3 py-2.5">
          <span className="text-[12px] font-semibold text-text-muted">Overall</span>
          <span className="font-mono text-[16px] font-semibold text-accent-2">
            {overallPct != null ? overallPct.toFixed(0) + "%" : "—"}
          </span>
        </div>

        {/* Refinement status — only meaningful once the judge has run. */}
        {result?.refinementTriggered && (
          <div className="flex items-center justify-between rounded-lg border border-border-2/60 bg-surface-2/40 px-3 py-2 text-[12px]">
            <span className="font-medium text-text-muted">Refinement</span>
            <span className={result.refinementSuccessful ? "text-success" : "text-text-dim"}>
              {result.refinementSuccessful ? "✓ Applied (V2)" : "Fell back to V1"}
            </span>
          </div>
        )}

        {/* One-line evaluator insight, when the judge supplied one. */}
        {judged && evalResult.evaluator_insight && (
          <p className="pt-1 text-[12px] leading-relaxed text-text-muted">
            <span className="font-semibold text-text-dim">Insight: </span>
            {evalResult.evaluator_insight}
          </p>
        )}
      </div>
    </div>
  );
}

// One metric row: name (+ help tooltip), 0–10 score, progress bar, and the
// judge's per-metric reasoning when present. min-w-0 + break-words keep long
// reasoning from overflowing on mobile; the label row uses gap + shrink so the
// score never wraps under the title on narrow widths.
function MetricCard({ metric }) {
  const { label, tooltip, score, reasoning } = metric;
  const absent = score == null;
  const pct = absent ? 0 : Math.max(0, Math.min(10, score)) * 10;
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-text-muted">{label}</span>
          <MetricInfo tooltip={tooltip} />
        </span>
        <span
          className={`shrink-0 font-mono text-[12px] ${absent ? "text-text-dim" : "text-text"}`}
        >
          {absent ? "—" : `${score % 1 === 0 ? score : score.toFixed(1)}/10`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      {reasoning && (
        <p className="mt-1.5 break-words text-[11px] leading-relaxed text-text-dim">
          {reasoning}
        </p>
      )}
    </div>
  );
}

// Accessible help affordance: a small "i" glyph carrying the metric description
// in a native title tooltip (works on desktop hover and avoids any custom
// overlay that could overflow the narrow Power-Mode column on mobile).
function MetricInfo({ tooltip }) {
  if (!tooltip) return null;
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      role="img"
      className="inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-border-2 text-[9px] font-bold leading-none text-text-dim transition hover:border-accent/60 hover:text-accent"
    >
      i
    </span>
  );
}

function RagSourcesCard({ result }) {
  const sources = result?.ragSources ?? [];
  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-dim">
          RAG Sources
        </div>
        <div className="text-[11px] font-medium text-text-dim">
          {sources.length} {sources.length === 1 ? "entry" : "entries"}
        </div>
      </div>

      {sources.length === 0 ? (
        <div className="mt-3 text-[13px] text-text-muted">
          {result ? "No grounded sources for this prompt." : "Awaiting first query…"}
        </div>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {sources.map((s, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-[11px] font-bold text-accent">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-text">{s.title}</div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2"
                    style={{ width: `${(s.similarity ?? 0) * 100}%` }}
                  />
                </div>
              </div>
              <span className="w-10 shrink-0 text-right font-mono text-[11px] text-text-muted">
                {((s.similarity ?? 0) * 100).toFixed(0)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Spinner
// ═══════════════════════════════════════════════════════════════════════════

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
