import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Eye,
  EyeOff,
  History,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  MessageCircleQuestion,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { BrandMark, EmptyState, Toggle, WindowBar } from "./components";
import { mockBootstrap, mockPlan, mockSources } from "./mock";
import type {
  AuthState,
  BootstrapData,
  CaptureResult,
  CaptureSource,
  NestedExplanation,
  PublicSettings,
  ResponseSection,
  TutorPlan,
  TutorSession,
  TutorStep,
} from "./types";

type View = "assistant" | "history" | "settings";
type Phase = "idle" | "thinking" | "step" | "error";
type TutorRequest = {
  question: string;
  previousPlan?: TutorPlan;
  sourceId: string;
  issue?: string;
  issueStepIndex?: number;
};

const starterPrompts = [
  {
    icon: <LayoutGrid size={17} />,
    label: "Show me how",
    prompt: "Show me how to complete what I am doing on this screen.",
  },
  {
    icon: <MessageCircleQuestion size={17} />,
    label: "Explain this screen",
    prompt: "Explain what I am looking at and the important controls.",
  },
  {
    icon: <WandSparkles size={17} />,
    label: "Help me fix an issue",
    prompt: "Help me understand and fix the issue visible on my screen.",
  },
];

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network/i.test(message))
    return "I couldn’t reach Gemini. Check your connection and try again.";
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function sourceFallbackArt(kind: CaptureSource["kind"]) {
  return (
    <div className={`source-art ${kind}`}>
      <span className="fake-bar" />
      <span className="fake-side" />
      <span className="fake-body">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function SourcePicker({
  sources,
  selected,
  loading,
  onClose,
  onRefresh,
  onSelect,
}: {
  sources: CaptureSource[];
  selected: string;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (source: CaptureSource) => void;
}) {
  const [filter, setFilter] = useState("");
  const visible = sources.filter((source) =>
    source.name.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="source-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Capture source</p>
            <h2 id="source-title">What should I look at?</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <div className="search-box">
          <Search size={15} />
          <input
            placeholder="Find a window"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <div className="source-grid">
          {loading ? (
            <div className="source-loading">
              <LoaderCircle className="spin" /> Looking for screens…
            </div>
          ) : (
            visible.map((source) => (
              <button
                key={source.id}
                className={`source-card ${source.id === selected ? "selected" : ""}`}
                onClick={() => onSelect(source)}
              >
                <div className="source-thumb">
                  {source.thumbnail ? (
                    <img src={source.thumbnail} alt="" />
                  ) : (
                    sourceFallbackArt(source.kind)
                  )}
                  <span className="source-check">
                    <Check size={13} />
                  </span>
                </div>
                <div className="source-meta">
                  {source.appIcon ? (
                    <img src={source.appIcon} alt="" />
                  ) : source.kind === "screen" ? (
                    <Monitor size={15} />
                  ) : (
                    <LayoutGrid size={15} />
                  )}
                  <span title={source.name}>{source.name}</span>
                </div>
              </button>
            ))
          )}
          {!loading && visible.length === 0 && (
            <p className="no-sources">No matching windows found.</p>
          )}
        </div>
        <div className="modal-foot">
          <p>
            <ShieldCheck size={14} /> Nothing is shared until you ask.
          </p>
          <button className="text-button" onClick={onRefresh}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </section>
    </div>
  );
}

function ScreenPreview({
  capture,
  source,
  step,
}: {
  capture: CaptureResult | null;
  source?: CaptureSource;
  step: TutorStep;
}) {
  const target = step.target;
  const image = capture?.dataUrl || source?.thumbnail;
  return (
    <div className="capture-preview">
      {image ? (
        <img
          src={image}
          alt={`Latest capture of ${capture?.sourceName || source?.name}`}
        />
      ) : (
        sourceFallbackArt("screen")
      )}
      {target && (
        <span
          className="preview-target"
          style={{
            left: `${target.x / 10}%`,
            top: `${target.y / 10}%`,
            width: `${target.width / 10}%`,
            height: `${target.height / 10}%`,
          }}
        />
      )}
      <span className="preview-live">
        <i /> Captured just now
      </span>
    </div>
  );
}

function StepList({
  steps,
  level,
  ancestry,
  source,
  revising,
  activeIndex: controlledActiveIndex,
  completedSteps: controlledCompletedSteps,
  onDone,
  onReport,
  onExplain,
  onShowTarget,
}: {
  steps: TutorStep[];
  level: number;
  ancestry: string[];
  source?: CaptureSource;
  revising: boolean;
  activeIndex?: number;
  completedSteps?: Set<number>;
  onDone?: (index: number) => void;
  onReport?: (index: number, issue: string) => void;
  onExplain: (
    step: TutorStep,
    ancestry: string[],
    issue?: string,
  ) => Promise<NestedExplanation>;
  onShowTarget: (step: TutorStep) => void;
}) {
  const [reportingIndex, setReportingIndex] = useState<number | null>(null);
  const [issue, setIssue] = useState("");
  const [localActiveIndex, setLocalActiveIndex] = useState(0);
  const [localCompletedSteps, setLocalCompletedSteps] = useState<Set<number>>(
    new Set(),
  );
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const [explanations, setExplanations] = useState<
    Record<number, NestedExplanation>
  >({});
  const [explanationLoading, setExplanationLoading] = useState<number | null>(
    null,
  );
  const [explanationError, setExplanationError] = useState<
    Record<number, string>
  >({});
  const stepRefs = useRef<Array<HTMLDivElement | null>>([]);
  const activeIndex = controlledActiveIndex ?? localActiveIndex;
  const completedSteps = controlledCompletedSteps ?? localCompletedSteps;
  const allDone = completedSteps.size >= steps.length;

  useEffect(() => {
    stepRefs.current[activeIndex]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [activeIndex]);

  useEffect(() => {
    setLocalActiveIndex(0);
    setLocalCompletedSteps(new Set());
    setExpandedSteps(new Set());
    setExplanations({});
    setExplanationError({});
  }, [steps]);

  const completeStep = (index: number) => {
    if (onDone) {
      onDone(index);
      return;
    }
    setLocalCompletedSteps((current) => new Set(current).add(index));
    setLocalActiveIndex(Math.min(index + 1, steps.length - 1));
  };

  const loadExplanation = async (index: number, reportedIssue?: string) => {
    const step = steps[index];
    if (!step) return;
    setExplanationLoading(index);
    setExplanationError((current) => ({ ...current, [index]: "" }));
    try {
      const explanation = await onExplain(step, ancestry, reportedIssue);
      setExplanations((current) => ({ ...current, [index]: explanation }));
      setExpandedSteps((current) => new Set(current).add(index));
    } catch (error) {
      setExplanationError((current) => ({
        ...current,
        [index]: friendlyError(error),
      }));
    } finally {
      setExplanationLoading(null);
    }
  };

  const submitIssue = (index: number) => {
    const clean = issue.trim();
    if (!clean) return;
    if (onReport) onReport(index, clean);
    else void loadExplanation(index, clean);
    setReportingIndex(null);
    setIssue("");
  };

  const toggleExplanation = async (index: number) => {
    if (explanations[index]) {
      setExpandedSteps((current) => {
        const next = new Set(current);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
      return;
    }
    await loadExplanation(index);
  };

  return (
    <div className={`plan-steps ${level > 0 ? "nested-steps" : ""}`}>
      {level > 0 && (
        <div
          className="nested-progress"
          aria-label={`${completedSteps.size} of ${steps.length} steps completed`}
        >
          <i
            style={{
              width: `${Math.round((completedSteps.size / steps.length) * 100)}%`,
            }}
          />
        </div>
      )}
      {steps.map((step, index) => {
        const done = completedSteps.has(index);
        const active = index === activeIndex && !allDone;
        return (
          <div
            key={`${index}-${step.title}`}
            ref={(element) => {
              stepRefs.current[index] = element;
            }}
            className={`plan-step ${level > 0 ? "nested-step" : ""} ${done ? "done" : ""} ${active ? "active" : ""}`}
          >
            <div className="plan-step-line">
              <span className="step-number">
                {done ? <Check size={15} /> : index + 1}
              </span>
              <div className="plan-step-copy">
                <small>{done ? "Completed" : `Step ${index + 1}`}</small>
                <h3>
                  {step.needsClarification
                    ? step.clarification || step.instruction
                    : step.instruction}
                </h3>
                <p>{step.detail}</p>
              </div>
            </div>
            {active && (
              <div className="step-actions">
                <button
                  className="done-button"
                  onClick={() => completeStep(index)}
                >
                  <Check size={15} /> Done
                </button>
                {step.target && source?.kind === "screen" && (
                  <button
                    className="step-text-button"
                    onClick={() => onShowTarget(step)}
                  >
                    <MousePointer2 size={14} /> Highlight
                  </button>
                )}
                <button
                  className="step-text-button explain"
                  disabled={explanationLoading === index}
                  onClick={() => void toggleExplanation(index)}
                >
                  {explanationLoading === index ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <MessageCircleQuestion size={13} />
                  )}
                  {expandedSteps.has(index)
                    ? "Hide details"
                    : "Explain further"}
                </button>
                <button
                  className="step-text-button issue"
                  onClick={() => {
                    setReportingIndex(index);
                    setIssue("");
                  }}
                >
                  Report issue
                </button>
              </div>
            )}
            {explanations[index] && (
              <div
                className={`nested-thread ${expandedSteps.has(index) ? "" : "collapsed"}`}
                aria-hidden={!expandedSteps.has(index)}
              >
                <div className="thread-avatar">
                  <BrandMark small />
                </div>
                <div className="thread-content">
                  <small>Expanded explanation</small>
                  <p>{explanations[index].summary}</p>
                  <StepList
                    steps={explanations[index].steps}
                    level={level + 1}
                    ancestry={[...ancestry, step.instruction]}
                    source={source}
                    revising={revising}
                    onExplain={onExplain}
                    onShowTarget={onShowTarget}
                  />
                  {explanations[index].tip && (
                    <div className="thread-tip">
                      <Sparkles size={12} />
                      <span>{explanations[index].tip}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
            {explanationError[index] && (
              <div className="nested-error">
                <EyeOff size={12} /> {explanationError[index]}{" "}
                <button onClick={() => void loadExplanation(index)}>
                  Retry
                </button>
              </div>
            )}
            {reportingIndex === index && (
              <div className="issue-box">
                <textarea
                  autoFocus
                  value={issue}
                  onChange={(event) => setIssue(event.target.value)}
                  placeholder="What happened or what do you see instead?"
                />
                <div>
                  <button onClick={() => setReportingIndex(null)}>
                    Cancel
                  </button>
                  <button
                    className="update-plan-button"
                    disabled={
                      !issue.trim() || revising || explanationLoading === index
                    }
                    onClick={() => submitIssue(index)}
                  >
                    {revising || explanationLoading === index ? (
                      <LoaderCircle className="spin" size={13} />
                    ) : (
                      <RefreshCw size={13} />
                    )}{" "}
                    {onReport ? "Update all steps" : "Update this branch"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {level > 0 && allDone && (
        <div className="nested-complete">
          <Check size={13} /> Branch complete
        </div>
      )}
    </div>
  );
}

function ResponseSections({
  sections,
  tone,
}: {
  sections: ResponseSection[];
  tone: "explanation" | "troubleshooting";
}) {
  return (
    <div className={`response-sections ${tone}`}>
      {sections.map((section, index) => (
        <article className="response-section" key={`${index}-${section.title}`}>
          <h3>{section.title}</h3>
          <p>{section.content}</p>
          {section.points.length > 0 && (
            <ul>
              {section.points.map((point, pointIndex) => (
                <li key={`${pointIndex}-${point}`}>{point}</li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  );
}

function TutorPlanCard({
  plan,
  activeIndex,
  completedSteps,
  capture,
  source,
  revising,
  onDone,
  onReport,
  onExplain,
  onShowTarget,
  onStop,
}: {
  plan: TutorPlan;
  activeIndex: number;
  completedSteps: Set<number>;
  capture: CaptureResult | null;
  source?: CaptureSource;
  revising: boolean;
  onDone: (index: number) => void;
  onReport: (index: number, issue: string) => void;
  onExplain: (
    step: TutorStep,
    ancestry: string[],
    issue?: string,
  ) => Promise<NestedExplanation>;
  onShowTarget: (step: TutorStep) => void;
  onStop: () => void;
}) {
  const responseType = plan.responseType || "guide";
  const sections = plan.sections || [];
  const isExplanation = responseType === "explanation";
  const activeStep = plan.steps[activeIndex];
  const allDone = plan.steps.length > 0 && completedSteps.size >= plan.steps.length;
  const eyebrow = responseType === "explanation"
    ? "Explanation"
    : responseType === "troubleshooting"
      ? "Troubleshooting"
      : "Your complete guide";

  if (isExplanation) {
    return (
      <section className="tutor-result explanation-result">
        <div className="result-intro">
          <span className="ai-orb explanation-orb">
            <MessageCircleQuestion size={19} />
          </span>
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{plan.title}</h2>
          </div>
        </div>
        <div className="plan-summary explanation-summary">
          <div>
            <strong>Overview</strong>
            <span>{plan.summary}</span>
          </div>
          <button onClick={onStop}>End</button>
        </div>
        <ResponseSections sections={sections} tone="explanation" />
        <div className="confidence">
          <span>Answer confidence</span>
          <span className="confidence-track">
            <i style={{ width: `${Math.round(plan.confidence * 100)}%` }} />
          </span>
          <strong>{Math.round(plan.confidence * 100)}%</strong>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`tutor-result plan-result ${revising ? "is-revising" : ""}`}
    >
      <div className="result-intro">
        <span className="ai-orb">
          <BrandMark small />
        </span>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{allDone || plan.completed ? "You’re all done" : plan.title}</h2>
        </div>
      </div>
      {activeStep?.target && !allDone && (
        <ScreenPreview capture={capture} source={source} step={activeStep} />
      )}
      <div className="plan-summary">
        <div>
          <strong>{plan.steps.length} {responseType === "troubleshooting" ? "checks" : "steps"}</strong>
          <span>{plan.summary}</span>
        </div>
        <button onClick={onStop}>End</button>
      </div>
      {sections.length > 0 && (
        <ResponseSections sections={sections} tone="troubleshooting" />
      )}
      <div className="plan-progress">
        <i
          style={{
            width: `${Math.round((completedSteps.size / plan.steps.length) * 100)}%`,
          }}
        />
      </div>
      <StepList
        steps={plan.steps}
        level={0}
        ancestry={[]}
        source={source}
        revising={revising}
        activeIndex={activeIndex}
        completedSteps={completedSteps}
        onDone={onDone}
        onReport={onReport}
        onExplain={onExplain}
        onShowTarget={onShowTarget}
      />
      {allDone && (
        <div className="plan-complete">
          <span>
            <Check size={20} />
          </span>
          <div>
            <strong>Guide complete</strong>
            <p>You finished every step in this tutorial.</p>
          </div>
          <button onClick={onStop}>Start another</button>
        </div>
      )}
      {revising && (
        <div className="revision-banner">
          <LoaderCircle className="spin" size={15} /> Checking the screen and
          updating the full plan…
        </div>
      )}
      <div className="confidence">
        <span>Plan confidence</span>
        <span className="confidence-track">
          <i style={{ width: `${Math.round(plan.confidence * 100)}%` }} />
        </span>
        <strong>{Math.round(plan.confidence * 100)}%</strong>
      </div>
    </section>
  );
}

function HistoryView({
  sessions,
  onClear,
  onResume,
}: {
  sessions: TutorSession[];
  onClear: () => void;
  onResume: (session: TutorSession) => void;
}) {
  return (
    <main className="page-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your activity</p>
          <h1>Recent answers</h1>
        </div>
        {sessions.length > 0 && (
          <button
            className="icon-button danger"
            aria-label="Clear history"
            onClick={onClear}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
      {sessions.length === 0 ? (
        <EmptyState
          icon={<History size={23} />}
          title="No answers yet"
          text="Your explanations, guides, and troubleshooting sessions will appear here."
        />
      ) : (
        <div className="history-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className="history-row"
              onClick={() => onResume(session)}
            >
              <span className="history-icon">
                <MessageCircleQuestion size={17} />
              </span>
              <span className="history-copy">
                <strong>{session.title}</strong>
                <small>
                  {session.sourceName} · {session.messages.length} messages
                </small>
              </span>
              <span className="history-time">
                <Clock3 size={12} />{" "}
                {new Date(session.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

function AuthView({
  initialError,
  onSignIn,
  onSignUp,
}: {
  initialError?: string;
  onSignIn: (email: string, password: string) => Promise<AuthState>;
  onSignUp: (email: string, password: string) => Promise<AuthState>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busyMode, setBusyMode] = useState<"sign-in" | "sign-up" | null>(null);
  const [authError, setAuthError] = useState(initialError || "");
  const [authMessage, setAuthMessage] = useState("");

  const submit = async (mode: "sign-in" | "sign-up") => {
    if (!email.trim() || !password) return;
    setBusyMode(mode);
    setAuthError("");
    setAuthMessage("");
    try {
      const action = mode === "sign-in" ? onSignIn : onSignUp;
      const result = await action(email.trim(), password);
      if (!result.signedIn) setAuthMessage(result.message || "Check your email, then sign in.");
    } catch (error) {
      setAuthError(friendlyError(error));
    } finally {
      setBusyMode(null);
    }
  };

  return (
    <main className="auth-gate">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <span><BrandMark /></span>
          <p className="eyebrow">Secure AI tutor</p>
          <h1 id="auth-title">Welcome to ScreenProf</h1>
          <p>Sign in before sharing a screen or opening your workspace.</p>
        </div>
        <div className="auth-fields gate-fields">
          <label>
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="At least 8 characters"
              value={password}
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit("sign-in");
              }}
            />
          </label>
        </div>
        {authError && <p className="auth-feedback error gate-feedback">{authError}</p>}
        {authMessage && <p className="auth-feedback gate-feedback">{authMessage}</p>}
        <div className="auth-gate-actions">
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busyMode) || !email.trim() || !password}
            onClick={() => void submit("sign-in")}
          >
            {busyMode === "sign-in" ? <LoaderCircle className="spin" size={15} /> : <LogIn size={15} />}
            Sign in
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busyMode) || !email.trim() || password.length < 8}
            onClick={() => void submit("sign-up")}
          >
            {busyMode === "sign-up" && <LoaderCircle className="spin" size={14} />}
            Create account
          </button>
        </div>
        <p className="auth-security-note">
          <ShieldCheck size={14} /> Your Gemini API key stays in Supabase and is never sent to this app.
        </p>
      </section>
    </main>
  );
}

function SettingsView({
  settings,
  auth,
  onSave,
  onClear,
  onSignOut,
}: {
  settings: PublicSettings;
  auth: AuthState;
  onSave: (update: { historyEnabled?: boolean }) => Promise<void>;
  onClear: () => void;
  onSignOut: () => Promise<void>;
}) {
  return (
    <main className="page-view settings-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Preferences</p>
          <h1>Settings</h1>
        </div>
      </div>
      <div className="settings-content">
        <section className="settings-section auth-section">
          <h3>ScreenProf account</h3>
          <div className="auth-signed-in">
            <div>
              <strong>Signed in</strong>
              <small>{auth.email || "Supabase user"}</small>
            </div>
            <button type="button" onClick={() => void onSignOut()}>
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </section>
        <section className="settings-section">
          <h3>Privacy</h3>
          <div className="setting-row">
            <div>
              <strong>Conversation history</strong>
              <small>Store tutor chats locally on this device</small>
            </div>
            <Toggle
              checked={settings.historyEnabled}
              label="Conversation history"
              onChange={(historyEnabled) => void onSave({ historyEnabled })}
            />
          </div>
          <div className="setting-row">
            <div>
              <strong>Screenshots</strong>
              <small>Captures are never saved to disk</small>
            </div>
            <span className="safe-label">
              <ShieldCheck size={14} /> Ephemeral
            </span>
          </div>
          <button type="button" className="danger-button" onClick={onClear}>
            <Trash2 size={15} /> Clear conversation history
          </button>
        </section>
        <section className="privacy-note">
          <ShieldCheck size={18} />
          <div>
            <strong>Built for privacy</strong>
            <p>
              ScreenProf captures only when you ask. It never clicks, types, or
              controls your computer.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

export function App() {
  const [collapsed, setCollapsed] = useState(Boolean(window.screenProf));
  const [bootReady, setBootReady] = useState(!window.screenProf);
  const [boot, setBoot] = useState<BootstrapData>(mockBootstrap);
  const [view, setView] = useState<View>("assistant");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [showSources, setShowSources] = useState(false);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [question, setQuestion] = useState("");
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState<TutorPlan | null>(null);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [revising, setRevising] = useState(false);
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const [sessionId, setSessionId] = useState<string>();
  const [error, setError] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const lastRequestRef = useRef<TutorRequest | null>(null);
  const selectedSource = sources.find(
    (source) => source.id === selectedSourceId,
  );
  const bridge = window.screenProf;

  useEffect(() => {
    let unsubscribe: undefined | (() => void);
    let unsubscribeWindow: undefined | (() => void);
    if (bridge) {
      bridge
        .bootstrap()
        .then((data) => {
          setBoot(data);
          setCollapsed(Boolean(data.collapsed));
          setBootReady(true);
        })
        .catch((err) => {
          setError(friendlyError(err));
          setBoot((current) => ({ ...current, auth: { signedIn: false, email: null } }));
          setBootReady(true);
        });
      unsubscribe = bridge.onSettingsChanged((settings) =>
        setBoot((current) => ({ ...current, settings })),
      );
      unsubscribeWindow = bridge.onWindowState((state) =>
        setCollapsed(state.collapsed),
      );
    }
    return () => {
      unsubscribe?.();
      unsubscribeWindow?.();
    };
  }, [bridge]);

  const loadSources = async () => {
    setSourcesLoading(true);
    try {
      const next = bridge ? await bridge.listSources() : mockSources;
      setSources(next);
      if (!selectedSourceId && next[0]) setSelectedSourceId(next[0].id);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSourcesLoading(false);
    }
  };

  const openSources = () => {
    setShowSources(true);
    void loadSources();
  };

  const ask = async (
    requestedQuestion = question,
    previousPlan?: TutorPlan,
    sourceOverride?: string,
    issue?: string,
    issueStepIndex?: number,
  ) => {
    const cleanQuestion = requestedQuestion.trim();
    if (!cleanQuestion) return textRef.current?.focus();
    if (!boot.auth.signedIn) {
      setError("Sign in from Settings to use the AI tutor.");
      setView("settings");
      return;
    }
    if (boot.settings.visionPaused) {
      setError("AI vision is paused. Resume it to ask about your screen.");
      setPhase("error");
      return;
    }
    const sourceId = sourceOverride || selectedSourceId;
    if (!sourceId) {
      setQuestion(cleanQuestion);
      openSources();
      return;
    }
    const isRevision = Boolean(previousPlan && issue);
    lastRequestRef.current = {
      question: cleanQuestion,
      previousPlan,
      sourceId,
      issue,
      issueStepIndex,
    };
    setGoal(cleanQuestion);
    setQuestion("");
    setError("");
    if (isRevision) setRevising(true);
    else setPhase("thinking");
    try {
      if (!bridge) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        setPlan(mockPlan);
        setCapture(null);
        setCompletedSteps(new Set());
        setActiveStepIndex(0);
        setPhase("step");
        setRevising(false);
        return;
      }
      const result = await bridge.askTutor({
        question: cleanQuestion,
        sourceId,
        sessionId,
        previousPlan,
        issue,
        currentStepIndex: issueStepIndex,
      });
      setPlan(result.plan);
      setCapture(result.capture);
      setSessionId(result.sessionId || undefined);
      if (isRevision) {
        const completedBeforeIssue = new Set<number>();
        for (
          let index = 0;
          index < Math.min(issueStepIndex || 0, result.plan.steps.length);
          index += 1
        )
          completedBeforeIssue.add(index);
        setCompletedSteps(completedBeforeIssue);
        setActiveStepIndex(
          Math.min(issueStepIndex || 0, result.plan.steps.length - 1),
        );
      } else {
        setCompletedSteps(new Set());
        setActiveStepIndex(0);
      }
      setBoot((current) => ({ ...current, sessions: result.sessions }));
      setPhase("step");
      setRevising(false);
    } catch (err) {
      setError(friendlyError(err));
      if (isRevision) setRevising(false);
      else setPhase("error");
    }
  };

  const completeStep = (index: number) => {
    if (!plan) return;
    setCompletedSteps((current) => new Set(current).add(index));
    const nextIndex = index + 1;
    if (nextIndex < plan.steps.length) {
      setActiveStepIndex(nextIndex);
      if (plan.steps[nextIndex].target)
        void bridge?.showOverlay(plan.steps[nextIndex]);
      else void bridge?.hideOverlay();
    } else {
      void bridge?.hideOverlay();
    }
  };
  const reportIssue = (index: number, issue: string) => {
    if (plan) void ask(goal, plan, undefined, issue, index);
  };
  const explainStep = async (
    step: TutorStep,
    ancestry: string[],
    issue?: string,
  ): Promise<NestedExplanation> => {
    if (!plan) throw new Error("This guide is no longer active.");
    if (!bridge) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      return {
        summary:
          "The Insert tab groups the tools that add new elements to your spreadsheet.",
        steps: [
          {
            ...step,
            title: "Find the Insert tab",
            instruction: "Look across the top ribbon for the word “Insert”.",
            detail: "It is usually between Home and Page Layout.",
            target: null,
            targetLabel: null,
          },
          {
            ...step,
            title: "Open the tab",
            instruction: "Click the “Insert” label once.",
            detail: "The ribbon changes to show tools for adding content.",
          },
          {
            ...step,
            title: "Confirm it opened",
            instruction:
              "Wait for the Charts group to appear below the ribbon.",
            detail: "Seeing chart icons means this branch is complete.",
            target: null,
            targetLabel: null,
          },
        ],
        tip: "If the ribbon is collapsed, double-click the Insert tab to keep it open.",
      };
    }
    return bridge.explainStep({
      question: goal,
      sourceId: selectedSourceId,
      step,
      ancestry,
      issue,
    });
  };
  const resetGuide = () => {
    setPhase("idle");
    setPlan(null);
    setCapture(null);
    setSessionId(undefined);
    setActiveStepIndex(0);
    setCompletedSteps(new Set());
    setRevising(false);
    setGoal("");
    lastRequestRef.current = null;
    bridge?.hideOverlay();
  };
  const retryLastRequest = () => {
    const request = lastRequestRef.current;
    if (!request) return;
    void ask(
      request.question,
      request.previousPlan,
      request.sourceId,
      request.issue,
      request.issueStepIndex,
    );
  };
  const updateSettings = async (update: {
    visionPaused?: boolean;
    historyEnabled?: boolean;
  }) => {
    try {
      const settings = bridge
        ? await bridge.updateSettings(update)
        : { ...boot.settings, ...update };
      setBoot((current) => ({ ...current, settings }));
      setError("");
    } catch (err) {
      setError(friendlyError(err));
    }
  };
  const toggleVision = () => {
    const visionPaused = !boot.settings.visionPaused;
    void updateSettings({ visionPaused });
    if (visionPaused) {
      bridge?.hideOverlay();
      resetGuide();
    }
  };
  const clearHistory = async () => {
    const sessions = bridge ? await bridge.clearHistory() : [];
    setBoot((current) => ({ ...current, sessions }));
  };
  const signInUser = async (email: string, password: string) => {
    const auth = bridge
      ? await bridge.signIn({ email, password })
      : { signedIn: true, email };
    if (auth.signedIn) {
      const accountBoot = bridge ? await bridge.bootstrap() : { ...boot, auth, sessions: [] };
      setBoot(accountBoot);
      setError("");
      setView("assistant");
    } else {
      setBoot((current) => ({ ...current, auth, sessions: [] }));
    }
    return auth;
  };
  const signUpUser = async (email: string, password: string) => {
    const auth = bridge
      ? await bridge.signUp({ email, password })
      : { signedIn: true, email };
    if (auth.signedIn) {
      const accountBoot = bridge ? await bridge.bootstrap() : { ...boot, auth, sessions: [] };
      setBoot(accountBoot);
      setError("");
      setView("assistant");
    } else {
      setBoot((current) => ({ ...current, auth, sessions: [] }));
    }
    return auth;
  };
  const signOutUser = async () => {
    const auth = bridge
      ? await bridge.signOut()
      : { signedIn: false, email: null };
    setBoot((current) => ({ ...current, auth, sessions: [] }));
    resetGuide();
  };
  const resumeSession = (session: TutorSession) => {
    const lastMessage = [...session.messages]
      .reverse()
      .find((message) => message.plan || message.step);
    const restoredPlan = lastMessage?.plan
      ? {
          ...lastMessage.plan,
          responseType: lastMessage.plan.responseType || "guide",
          sections: lastMessage.plan.sections || [],
        }
      : lastMessage?.step
        ? {
            responseType: "guide" as const,
            title: session.title,
            summary: "Restored from an earlier ScreenProf guide.",
            sections: [],
            steps: [lastMessage.step],
            confidence: lastMessage.step.confidence,
            completed: lastMessage.step.completed,
          }
        : null;
    setSessionId(session.id);
    setGoal(session.title);
    setPlan(restoredPlan);
    setCompletedSteps(new Set());
    setActiveStepIndex(0);
    setPhase(restoredPlan ? "step" : "idle");
    setView("assistant");
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void ask();
    }
  };
  const sourceLabel = useMemo(
    () =>
      selectedSource?.name ||
      (sources.length ? "Choose a source" : "Select your screen"),
    [selectedSource, sources],
  );

  if (collapsed) {
    return (
      <div
        className={`orb-shell ${boot.settings.visionPaused ? "paused" : ""}`}
      >
        <div className="orb-drag-handle" title="Drag ScreenProf" aria-hidden="true" />
        <button
          className="orb-button"
          aria-label="Open ScreenProf"
          onClick={() => {
            setCollapsed(false);
            void bridge?.expand();
          }}
        >
          <BrandMark />
        </button>
        <span className="orb-status" />
      </div>
    );
  }

  if (!bootReady) {
    return (
      <div className="app-shell auth-shell">
        <WindowBar
          onCollapse={() => {
            setCollapsed(true);
            void bridge?.collapse();
          }}
        />
        <main className="auth-gate auth-loading">
          <LoaderCircle className="spin" size={24} />
          <span>Checking your secure session...</span>
        </main>
      </div>
    );
  }

  if (!boot.auth.signedIn) {
    return (
      <div className="app-shell auth-shell">
        <WindowBar
          onCollapse={() => {
            setCollapsed(true);
            void bridge?.collapse();
          }}
        />
        <AuthView
          initialError={error}
          onSignIn={signInUser}
          onSignUp={signUpUser}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <WindowBar
        onCollapse={() => {
          setCollapsed(true);
          void bridge?.collapse();
        }}
      />
      <div className="app-body">
        <div className="status-row">
          <button
            className={`vision-status ${boot.settings.visionPaused ? "paused" : ""}`}
            onClick={toggleVision}
          >
            {boot.settings.visionPaused ? (
              <Pause size={13} fill="currentColor" />
            ) : (
              <span className="pulse-dot" />
            )}
            {boot.settings.visionPaused ? "Vision paused" : "Vision ready"}
          </button>
          <div className="status-actions">
            <button className="source-select" onClick={openSources}>
              <Monitor size={14} />
              <span>{sourceLabel}</span>
              <ChevronDown size={13} />
            </button>
            <button
              className="new-session-button"
              onClick={() => {
                resetGuide();
                setView("assistant");
              }}
            >
              <Plus size={14} /> New
            </button>
          </div>
        </div>

        {view === "assistant" && (
          <main className="assistant-view">
            {phase === "idle" && (
              <div className="hero">
                <div className="hero-icon">
                  <BrandMark />
                </div>
                <p className="eyebrow">Your on-screen guide</p>
                <h1>
                  What can I help
                  <br />
                  you do?
                </h1>
                <p className="hero-subtitle">
                  Ask about anything on your screen. I’ll build the complete
                  guide before you begin.
                </p>
                <div className="starter-list">
                  {starterPrompts.map((item) => (
                    <button
                      key={item.label}
                      onClick={() => {
                        setQuestion(item.prompt);
                        textRef.current?.focus();
                      }}
                    >
                      <span>{item.icon}</span>
                      {item.label}
                      <ArrowRight size={15} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {phase === "thinking" && (
              <div className="thinking-state">
                <div className="scan-orb">
                  <Eye size={25} />
                  <span />
                </div>
      
                <h2>Understanding your screen…</h2>
                
                <div className="scan-lines">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            )}
            {phase === "step" && plan && (
              <TutorPlanCard
                plan={plan}
                activeIndex={activeStepIndex}
                completedSteps={completedSteps}
                capture={capture}
                source={selectedSource}
                revising={revising}
                onDone={completeStep}
                onReport={reportIssue}
                onExplain={explainStep}
                onShowTarget={(step) => bridge?.showOverlay(step)}
                onStop={resetGuide}
              />
            )}
            {phase === "error" && (
              <EmptyState
                icon={<EyeOff size={23} />}
                title="I couldn’t see that"
                text={error}
                action={
                  <button
                    className="secondary-button"
                    onClick={retryLastRequest}
                  >
                    Try again
                  </button>
                }
              />
            )}
          </main>
        )}
        {view === "history" && (
          <HistoryView
            sessions={boot.sessions}
            onClear={() => void clearHistory()}
            onResume={resumeSession}
          />
        )}
        {view === "settings" && (
          <SettingsView
            settings={boot.settings}
            auth={boot.auth}
            onSave={updateSettings}
            onClear={() => void clearHistory()}
            onSignOut={signOutUser}
          />
        )}

        {view === "assistant" && phase !== "thinking" && (
          <div className="composer-wrap">
            {error && phase !== "error" && (
              <div className="inline-error">
                <EyeOff size={14} />
                {error}
                <button onClick={() => setError("")}>
                  <X size={13} />
                </button>
              </div>
            )}
            <div className="composer">
              <textarea
                ref={textRef}
                rows={1}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={keyDown}
                placeholder={
                  phase === "step"
                    ? "Ask a follow-up…"
                    : "Ask about your screen…"
                }
                disabled={boot.settings.visionPaused || !boot.auth.signedIn}
              />
              <button
                className="send-button"
                onClick={() => void ask()}
                disabled={!question.trim() || boot.settings.visionPaused || !boot.auth.signedIn}
                aria-label="Send"
              >
                <Send size={17} />
              </button>
            </div>
            <p className="composer-hint">
              <ShieldCheck size={12} /> Captured only when you send
            </p>
          </div>
        )}
      </div>
      <nav className="bottom-nav" aria-label="Main navigation">
        <button
          className={view === "assistant" ? "active" : ""}
          onClick={() => setView("assistant")}
        >
          <BrandMark small />
          Tutor
        </button>
        <button
          className={view === "history" ? "active" : ""}
          onClick={() => setView("history")}
        >
          <History size={18} />
          History
        </button>
        <button
          className={view === "settings" ? "active" : ""}
          onClick={() => setView("settings")}
        >
          <Settings size={18} />
          Settings
        </button>
      </nav>
      {showSources && (
        <SourcePicker
          sources={sources}
          selected={selectedSourceId}
          loading={sourcesLoading}
          onClose={() => setShowSources(false)}
          onRefresh={() => void loadSources()}
          onSelect={(source) => {
            const pending = question;
            setSelectedSourceId(source.id);
            setShowSources(false);
            if (pending.trim()) void ask(pending, undefined, source.id);
          }}
        />
      )}
    </div>
  );
}
