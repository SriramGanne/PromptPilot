"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import NavTabs from "./_components/NavTabs";

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

  // React 19: async callbacks inside startTransition keep the UI responsive
  // without needing a manual isLoading flag.
  const [isPending, startTransition] = useTransition();

  // Refs for focus management + auto-scroll.
  const intentRef = useRef(null);      // <textarea> on step 1 — focused on "Start over"
  const resultRef = useRef(null);      // Improved Prompt panel — scrolled into view on generation
  const didAutoScrollRef = useRef(false); // one-shot guard so we don't re-scroll on every token
  const returnToIntentRef = useRef(false); // set by handleStartOver, consumed by useEffect below

  // Transient "generation complete" flag — drives a fade-out border pulse.
  const [justCompleted, setJustCompleted] = useState(false);

  // Auto-scroll the result panel into view the first time tokens start
  // arriving. Gated by didAutoScrollRef so mid-stream re-renders don't
  // hijack the scroll position while the user is reading.
  useEffect(() => {
    if (step === 3 && optimizedPrompt && !didAutoScrollRef.current) {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      didAutoScrollRef.current = true;
    }
  }, [step, optimizedPrompt]);

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

  // Streaming NDJSON reader. The server emits one event per line:
  //   clarifying | cached | meta | token | done | error
  // We update state incrementally so the optimized prompt renders as it is
  // generated, not after the full synthesis completes.
  async function callApi(userInput) {
    setError("");
    setResult(null); // clear prior run — critical so stale optimized prompt
                     //                   doesn't flash while we await clarifying
    setThinkingContent("");
    setOptimizedPrompt("");
    setCopied(false);
    setJustCompleted(false);
    didAutoScrollRef.current = false; // re-arm auto-scroll for this run

    const res = await fetch("/api/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userInput, targetModel }),
    });
    if (!res.ok || !res.body) {
      setError(`Request failed (${res.status})`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamedPrompt = "";
    let metaPayload = null;

    // Updates the split output states from the running raw buffer. Called
    // on every streamed token AND on the final `done`/`cached` events to
    // guarantee the UI converges on the complete parse.
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
          setQuestions(ev.questions ?? []);
          setAnswers(new Array(ev.questions?.length ?? 0).fill(""));
          setClarityScore(ev.clarityScore ?? null);
          setStep(2);
          break;
        case "cached":
          setResult(ev);
          syncSplitStates(ev.optimizedPrompt ?? "");
          setClarityScore(ev.clarityScore ?? null);
          setStep(3);
          break;
        case "meta":
          metaPayload = ev;
          setResult({ ...ev, optimizedPrompt: "", streaming: true });
          setClarityScore(ev.clarityScore ?? null);
          setStep(3);
          break;
        case "token":
          streamedPrompt += ev.content;
          setResult((prev) => ({
            ...(prev ?? metaPayload ?? {}),
            optimizedPrompt: streamedPrompt,
            streaming: true,
          }));
          syncSplitStates(streamedPrompt);
          break;
        case "done":
          setResult({ ...ev, streaming: false });
          syncSplitStates(ev.optimizedPrompt ?? "");
          break;
        case "error":
          setError(ev.error || "Stream error");
          break;
      }
    };

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
  }

  function handleStep1Submit(e) {
    e.preventDefault();
    if (!intent.trim()) return;
    startTransition(() => callApi(intent.trim()));
  }

  function handleStep2Submit(e) {
    e.preventDefault();
    const enriched =
      `${intent.trim()}\n\n--- Additional context ---\n` +
      questions
        .map((q, i) => `Q: ${q}\nA: ${(answers[i] ?? "").trim() || "(not specified)"}`)
        .join("\n\n");
    startTransition(() => callApi(enriched));
  }

  function handleStartOver() {
    returnToIntentRef.current = true; // consumed by useEffect on [step]
    setStep(1);
    setQuestions([]);
    setAnswers([]);
    setResult(null);
    setThinkingContent("");
    setOptimizedPrompt("");
    setError("");
    setClarityScore(null);
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

  return (
    <div className="min-h-screen text-text">
      <Header powerMode={powerMode} setPowerMode={setPowerMode} />

      <main
        className={`mx-auto w-full max-w-[1280px] px-6 pb-20 pt-8 grid gap-8 transition-[grid-template-columns] duration-300 ease-out ${
          powerMode ? "grid-cols-1 lg:grid-cols-[1fr_350px]" : "grid-cols-1"
        }`}
      >
        {/* ── Wizard column ───────────────────────────────────────────── */}
        <section className="min-w-0">
          <Stepper currentStep={step} />

          <div className="mt-8 rounded-2xl border border-border bg-surface/80 backdrop-blur-sm shadow-[0_20px_60px_-20px_rgba(0,0,0,0.6)]">
            {error && (
              <div className="mx-6 mt-6 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
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
                questions={questions}
                answers={answers}
                setAnswers={setAnswers}
                clarityScore={clarityScore}
                onSubmit={handleStep2Submit}
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

function Header({ powerMode, setPowerMode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent to-accent-2 shadow-[0_4px_14px_rgba(124,58,237,0.45)]" />
            <span className="text-[17px] font-semibold tracking-tight text-text">
              PromptBuddy
            </span>
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
              className={`truncate text-[13px] font-medium tracking-wide ${
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
  questions, answers, setAnswers, clarityScore, onSubmit, onBack, isPending,
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
          <h2 className="text-lg font-semibold text-text">Help us sharpen this</h2>
          <p className="mt-1 text-sm text-text-muted">
            Your intent is a bit ambiguous. Answer what you can — anything you skip will be
            left open for the model to infer.
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

      <div className="mt-6 space-y-4">
        {questions.map((q, i) => (
          <div
            key={i}
            className="rounded-xl border border-border bg-surface-2/60 p-4"
            style={{ animation: `fadeIn 300ms ease-out ${i * 60}ms both` }}
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

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          className="rounded-xl border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text-muted transition hover:border-border-2 hover:text-text disabled:opacity-40"
        >
          ← Back
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
  parsed,
  result,
  targetModel,
  copied,
  onCopy,
  onStartOver,
  powerMode,
}) {
  const streaming = result?.streaming;
  // Thinking has arrived (or is arriving) if either thinkingContent or any
  // other reasoning region has non-empty text. Keeps the box hidden until
  // there's something to show, so it doesn't flash empty during the meta event.
  const hasReasoning =
    Boolean(thinkingContent) || Boolean(parsed.grounding) || Boolean(parsed.evalPrediction);

  // Streaming phase: while we're still inside <thinking>, optimizedPrompt is
  // empty. Show the streaming cursor in the reasoning box. Once ### PROMPT
  // START arrives, optimizedPrompt starts filling and the cursor moves there.
  const cursorInReasoning = streaming && !optimizedPrompt;
  const cursorInPrompt = streaming && Boolean(optimizedPrompt);

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
      {powerMode && (hasReasoning || cursorInReasoning) && (
        <ReasoningDisclosure
          thinking={thinkingContent}
          grounding={parsed.grounding}
          evalPrediction={parsed.evalPrediction}
          showCursor={cursorInReasoning}
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
          <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-text">
            {optimizedPrompt}
            {cursorInPrompt && (
              <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-accent-2 align-baseline" />
            )}
            {!optimizedPrompt && !streaming && (
              <span className="text-text-dim italic">No prompt returned.</span>
            )}
          </pre>
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
  const hit = result?.cacheHit === true;
  const miss = result && !hit;
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
          {idle ? "Idle" : hit ? "Hit" : "Miss"}
        </div>
      </div>

      <div className="mt-3 text-[13px] text-text-muted">
        {idle && "Awaiting first query…"}
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
  // Ragas-style derived metrics:
  //   • faithfulness — from the API (answer grounded in retrieved context)
  //   • relevancy    — mean cosine similarity of the RAG sources (context ↔ query)
  const faithfulness = result?.faithfulnessScore;
  const relevancy = useMemo(() => {
    if (!result?.ragSources?.length) return null;
    return (
      result.ragSources.reduce((s, src) => s + (src.similarity ?? 0), 0) /
      result.ragSources.length
    );
  }, [result]);

  const overall =
    faithfulness != null && relevancy != null ? (faithfulness + relevancy) / 2 : null;

  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-dim">
          Quality Dashboard
        </div>
        <div className="text-[11px] font-medium text-text-dim">Ragas</div>
      </div>

      <div className="mt-4 space-y-3">
        <ScoreBar label="Faithfulness" value={faithfulness} />
        <ScoreBar label="Relevancy"    value={relevancy} />
        <div className="mt-3 flex items-center justify-between rounded-lg border border-border-2/60 bg-surface-2/60 px-3 py-2.5">
          <span className="text-[12px] font-semibold text-text-muted">Overall</span>
          <span className="font-mono text-[16px] font-semibold text-accent-2">
            {overall != null ? (overall * 100).toFixed(0) + "%" : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function ScoreBar({ label, value }) {
  const pct = value != null ? Math.max(0, Math.min(1, value)) * 100 : 0;
  const absent = value == null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium text-text-muted">{label}</span>
        <span className={`font-mono text-[12px] ${absent ? "text-text-dim" : "text-text"}`}>
          {absent ? "—" : (pct).toFixed(0) + "%"}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
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
