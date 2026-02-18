"use client";

import { useState, useEffect } from "react";

const TARGET_MODELS = ["ChatGPT", "Claude", "Gemini", "Grok"];

export default function Home() {
  const [userInput, setUserInput] = useState("");
  const [targetModel, setTargetModel] = useState(TARGET_MODELS[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [globalStats, setGlobalStats] = useState(null);

  // Fetch global stats on mount — non-blocking, silent failure
  useEffect(() => {
    fetch("/api/stats")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setGlobalStats(data); })
      .catch(() => {});
  }, []);

  async function handleSubmit() {
    if (!userInput.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    setCopied(false);

    try {
      const res = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userInput, targetModel }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setUserInput("");
    setResult(null);
    setError("");
    setCopied(false);
  }

  async function handleCopy() {
    if (!result?.optimizedPrompt) return;
    try {
      await navigator.clipboard.writeText(result.optimizedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard access denied — fail silently */
    }
  }

  const metrics = result
    ? {
        original: result.originalTokens,
        optimized: result.optimizedTokens,
        reduction: result.reductionPercent,
      }
    : { original: 0, optimized: 0, reduction: 0 };

  const showMetrics = result !== null;

  return (
    <div style={s.page}>
      {/* Hover styles — injected once, enables :hover without a CSS file */}
      <style>{`
        .pb-primary:hover:not(:disabled) {
          filter: brightness(1.1);
          box-shadow: 0 10px 28px rgba(79,70,229,0.35);
        }
        .pb-secondary:hover:not(:disabled) {
          background: #F8FAFC !important;
          border-color: #CBD5E1 !important;
        }
        .pb-copy:hover {
          background: rgba(79,70,229,0.06) !important;
          box-shadow: 0 0 12px rgba(99,102,241,0.15);
        }
        .pb-metric:hover {
          transform: translateY(-2px);
          box-shadow: 0 12px 32px rgba(15,23,42,0.08);
        }
        .pb-select:focus {
          border-color: #A5B4FC !important;
          box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
        }
        .pb-feedback:hover {
          color: #4F46E5 !important;
          text-decoration: underline;
        }

        /* ── Mobile (≤768px) ── */
        @media (max-width: 768px) {
          .pb-container {
            padding: 28px 16px 48px !important;
          }
          .pb-hero-title {
            font-size: 34px !important;
          }
          .pb-hero-subtitle {
            font-size: 16px !important;
          }
          .pb-hero {
            margin-bottom: 36px !important;
          }
          .pb-controls {
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 12px !important;
          }
          .pb-select-group {
            width: 100% !important;
          }
          .pb-select-group select {
            flex: 1 !important;
          }
          .pb-btn-group {
            flex-direction: column !important;
            gap: 10px !important;
          }
          .pb-btn-group button {
            width: 100% !important;
            padding: 12px 20px !important;
            justify-content: center !important;
          }
          .pb-panels {
            gap: 16px !important;
          }
          .pb-panel {
            flex-basis: 100% !important;
            min-height: auto !important;
          }
          .pb-panel textarea {
            min-height: 180px !important;
          }
          .pb-metrics-row {
            flex-direction: column !important;
            gap: 12px !important;
          }
          .pb-metric {
            max-width: none !important;
            flex-basis: 100% !important;
          }
          .pb-global-row {
            gap: 28px 0 !important;
            flex-direction: column !important;
          }
        }
      `}</style>

      <div className="pb-container" style={s.container}>
        {/* ── Hero ── */}
        <header className="pb-hero" style={s.hero}>
          <h1 className="pb-hero-title" style={s.title}>PromptBuddy</h1>
          <p className="pb-hero-subtitle" style={s.subtitle}>
            Turn plain thoughts into powerful prompts.
          </p>
        </header>

        {/* ── Controls Row ── */}
        <div className="pb-controls" style={s.controlsRow}>
          <div className="pb-select-group" style={s.selectGroup}>
            <label style={s.selectLabel} htmlFor="targetModel">
              Optimize for:
            </label>
            <select
              id="targetModel"
              className="pb-select"
              style={s.select}
              value={targetModel}
              onChange={(e) => setTargetModel(e.target.value)}
            >
              {TARGET_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div className="pb-btn-group" style={s.buttonGroup}>
            <button
              className="pb-primary"
              style={{
                ...s.primaryBtn,
                ...(loading || !userInput.trim() ? s.btnDisabled : {}),
              }}
              onClick={handleSubmit}
              disabled={loading || !userInput.trim()}
            >
              {loading ? "Optimizing…" : "Improve Prompt"}
            </button>
            <button
              className="pb-secondary"
              style={{
                ...s.secondaryBtn,
                ...(loading ? s.btnDisabled : {}),
              }}
              onClick={handleClear}
              disabled={loading}
            >
              Clear
            </button>
          </div>
        </div>

        {/* ── Error ── */}
        {error && <div style={s.error}>{error}</div>}

        {/* ── Side-by-Side Panels ── */}
        <div className="pb-panels" style={s.panelsRow}>
          {/* Left: Original */}
          <div className="pb-panel" style={s.panel}>
            <div style={s.panelHeader}>
              <h2 style={s.panelTitle}>Original Prompt</h2>
            </div>
            <textarea
              style={s.textarea}
              rows={10}
              placeholder={`Paste your raw prompt here…\nExample: Explain blockchain in simple terms.`}
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
            />
          </div>

          {/* Right: Optimized */}
          <div className="pb-panel" style={{ ...s.panel, ...s.panelOptimized }}>
            <div style={s.panelHeader}>
              <div>
                <h2 style={s.panelTitle}>Optimized Prompt</h2>
                {result && (
                  <span style={s.modelBadge}>
                    Optimized for: {targetModel}
                  </span>
                )}
              </div>
              {result?.optimizedPrompt && (
                <button
                  className="pb-copy"
                  style={s.copyBtn}
                  onClick={handleCopy}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              )}
            </div>
            <div style={s.outputBlock}>
              {loading ? (
                <div style={s.loadingWrap}>
                  <div style={s.loadingBar}>
                    <div style={s.loadingBarInner} />
                  </div>
                  <span style={s.loadingText}>Optimizing your prompt…</span>
                </div>
              ) : result?.optimizedPrompt ? (
                <pre style={s.pre}>{result.optimizedPrompt}</pre>
              ) : (
                <span style={s.placeholder}>
                  Optimized prompt will appear here.
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Token Metrics ── */}
        {showMetrics && (
          <div className="pb-metrics-row" style={s.metricsRow}>
            <div className="pb-metric" style={s.metricCard}>
              <span style={s.metricLabel}>Original Tokens</span>
              <span style={s.metricValue}>{metrics.original}</span>
            </div>
            <div className="pb-metric" style={s.metricCard}>
              <span style={s.metricLabel}>Optimized Tokens</span>
              <span style={s.metricValue}>{metrics.optimized}</span>
            </div>
            <div className="pb-metric" style={s.metricCard}>
              <span style={s.metricLabel}>Reduction</span>
              <span
                style={{
                  ...s.metricValue,
                  color: metrics.reduction > 0 ? C.positive : C.muted,
                }}
              >
                {metrics.reduction > 0
                  ? `${metrics.reduction}%`
                  : `${metrics.reduction}%`}
              </span>
              {metrics.reduction > 0 && (
                <span style={s.metricSub}>fewer tokens</span>
              )}
            </div>
          </div>
        )}
        {/* ── Global Optimization Impact ── */}
        {globalStats?.showStats && (
          <section style={s.globalSection}>
            <div style={s.globalDivider} />
            <h3 style={s.globalTitle}>Global Optimization Impact</h3>
            <div className="pb-global-row" style={s.globalRow}>
              <div style={s.globalStat}>
                <span style={s.globalValue}>
                  {globalStats.totalOptimizations.toLocaleString()}
                </span>
                <span style={s.globalLabel}>prompts optimized</span>
              </div>
              <div style={s.globalStat}>
                <span style={{ ...s.globalValue, color: C.positive }}>
                  {globalStats.avgReduction}%
                </span>
                <span style={s.globalLabel}>average reduction</span>
              </div>
              <div style={s.globalStat}>
                <span style={s.globalValue}>
                  {globalStats.totalTokensSaved.toLocaleString()}
                </span>
                <span style={s.globalLabel}>tokens saved</span>
              </div>
              <div style={s.globalStat}>
                <span style={s.globalValue}>
                  {globalStats.mostUsedModel}
                </span>
                <span style={s.globalLabel}>most optimized for</span>
              </div>
            </div>
          </section>
        )}

        {/* ── Disclaimer ── */}
        <p style={s.disclaimer}>
          Your prompts are not stored.<br />
          Optimization powered by Google Gemma.
        </p>

        {/* ── Feedback ── */}
        <div style={s.feedbackWrap}>
          <a
            className="pb-feedback"
            style={s.feedbackLink}
            href="https://forms.gle/CCEjrQYFFye3PG6K7"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Share feedback about PromptBuddy"
          >
            Have feedback? Share it →
          </a>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────── */
/*  Design Tokens                                  */
/* ─────────────────────────────────────────────── */

const C = {
  bg: "#F8FAFC",
  surface: "#FFFFFF",
  border: "#E2E8F0",
  text: "#0F172A",
  muted: "#64748B",
  accent: "#4F46E5",
  accentLight: "#6366F1",
  positive: "#10B981",
  errorBg: "#FEF2F2",
  errorBorder: "#FECACA",
  errorText: "#B91C1C",
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FONT_MONO =
  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

/* ─────────────────────────────────────────────── */
/*  Styles                                         */
/* ─────────────────────────────────────────────── */

const s = {
  /* Page shell */
  page: {
    minHeight: "100vh",
    background: `${C.bg}`,
    backgroundImage:
      "radial-gradient(circle at 50% 0%, rgba(99,102,241,0.08), transparent 60%)",
    fontFamily: FONT,
    color: C.text,
  },
  container: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "48px 28px 64px",
  },

  /* Hero */
  hero: {
    textAlign: "center",
    marginBottom: 60,
  },
  title: {
    fontSize: 48,
    fontWeight: 700,
    margin: 0,
    color: C.text,
    letterSpacing: "-0.02em",
  },
  subtitle: {
    fontSize: 19,
    color: C.muted,
    marginTop: 10,
    fontWeight: 400,
  },

  /* Controls */
  controlsRow: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 14,
    marginBottom: 28,
  },
  selectGroup: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  selectLabel: {
    fontSize: 14,
    fontWeight: 500,
    color: C.muted,
    whiteSpace: "nowrap",
  },
  select: {
    padding: "10px 16px",
    fontSize: 14,
    fontFamily: FONT,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    background: C.surface,
    color: C.text,
    cursor: "pointer",
    outline: "none",
    boxShadow: "inset 0 1px 2px rgba(15,23,42,0.04)",
    transition: "border-color 150ms ease, box-shadow 150ms ease",
  },
  buttonGroup: {
    display: "flex",
    gap: 10,
  },
  primaryBtn: {
    padding: "10px 26px",
    fontSize: 14,
    fontWeight: 600,
    color: "#fff",
    background: `linear-gradient(135deg, ${C.accent}, ${C.accentLight})`,
    border: "none",
    borderRadius: 12,
    cursor: "pointer",
    fontFamily: FONT,
    boxShadow: "0 8px 20px rgba(79,70,229,0.25)",
    transition: "filter 150ms ease, box-shadow 150ms ease",
  },
  secondaryBtn: {
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 500,
    color: C.text,
    backgroundColor: "transparent",
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    cursor: "pointer",
    fontFamily: FONT,
    transition: "background 150ms ease, border-color 150ms ease",
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
    pointerEvents: "none",
  },

  /* Error */
  error: {
    padding: 14,
    fontSize: 14,
    color: C.errorText,
    background: C.errorBg,
    border: `1px solid ${C.errorBorder}`,
    borderRadius: 12,
    marginBottom: 20,
  },

  /* Panels */
  panelsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 24,
    marginBottom: 28,
  },
  panel: {
    flex: "1 1 360px",
    display: "flex",
    flexDirection: "column",
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 18,
    boxShadow: "0 10px 30px rgba(15,23,42,0.05)",
    overflow: "hidden",
  },
  panelOptimized: {
    borderColor: "rgba(79,70,229,0.2)",
  },
  panelHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "18px 24px 14px",
    borderBottom: `1px solid ${C.border}`,
  },
  panelTitle: {
    fontSize: 15,
    fontWeight: 600,
    margin: 0,
    color: C.text,
  },
  modelBadge: {
    display: "inline-block",
    fontSize: 12,
    color: C.muted,
    marginTop: 4,
  },
  copyBtn: {
    padding: "5px 14px",
    fontSize: 12,
    fontWeight: 500,
    color: C.accent,
    background: "transparent",
    border: `1px solid rgba(79,70,229,0.3)`,
    borderRadius: 10,
    cursor: "pointer",
    fontFamily: FONT,
    whiteSpace: "nowrap",
    flexShrink: 0,
    transition: "background 150ms ease, box-shadow 150ms ease",
  },

  /* Textarea (left panel) */
  textarea: {
    flex: 1,
    minHeight: 260,
    padding: "20px 24px",
    fontSize: 14,
    lineHeight: 1.7,
    fontFamily: FONT,
    color: C.text,
    border: "none",
    outline: "none",
    resize: "vertical",
    boxSizing: "border-box",
    background: C.surface,
  },

  /* Output block (right panel) */
  outputBlock: {
    flex: 1,
    minHeight: 260,
    padding: "20px 24px",
    display: "flex",
    alignItems: "flex-start",
  },
  pre: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.7,
    fontFamily: FONT_MONO,
    color: C.text,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  placeholder: {
    fontSize: 14,
    color: C.muted,
    fontStyle: "italic",
  },

  /* Loading */
  loadingWrap: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    paddingTop: 8,
  },
  loadingBar: {
    height: 4,
    background: C.border,
    borderRadius: 4,
    overflow: "hidden",
  },
  loadingBarInner: {
    height: "100%",
    width: "40%",
    background: `linear-gradient(90deg, ${C.accent}, ${C.accentLight})`,
    borderRadius: 4,
    animation: "slide 1.2s ease-in-out infinite",
  },
  loadingText: {
    fontSize: 13,
    color: C.muted,
  },

  /* Metrics */
  metricsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    justifyContent: "center",
  },
  metricCard: {
    flex: "1 1 160px",
    maxWidth: 240,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "22px 16px",
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    boxShadow: "0 4px 16px rgba(15,23,42,0.04)",
    transition: "transform 150ms ease, box-shadow 150ms ease",
  },
  metricLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  metricValue: {
    fontSize: 28,
    fontWeight: 700,
    marginTop: 6,
    lineHeight: 1,
    color: C.text,
  },
  metricSub: {
    fontSize: 12,
    fontWeight: 500,
    color: C.muted,
    marginTop: 4,
  },

  /* Global Stats */
  globalSection: {
    marginTop: 56,
    textAlign: "center",
  },
  globalDivider: {
    width: 48,
    height: 1,
    background: C.border,
    margin: "0 auto 24px",
  },
  globalTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 28,
  },
  globalRow: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "36px 56px",
  },
  globalStat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  globalValue: {
    fontSize: 24,
    fontWeight: 700,
    color: C.text,
    lineHeight: 1,
  },
  globalLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: C.muted,
  },

  /* Disclaimer */
  disclaimer: {
    marginTop: 32,
    textAlign: "center",
    fontSize: 12,
    fontWeight: 400,
    color: C.muted,
    lineHeight: 1.8,
  },

  /* Feedback */
  feedbackWrap: {
    marginTop: 40,
    textAlign: "center",
  },
  feedbackLink: {
    fontSize: 13,
    fontWeight: 500,
    color: C.muted,
    textDecoration: "none",
    cursor: "pointer",
    transition: "color 150ms ease",
  },
};
