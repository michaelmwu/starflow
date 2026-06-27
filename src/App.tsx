import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Compass,
  LogOut,
  MessageCircle,
  Moon,
  Sparkles,
  Stars,
} from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type User = {
  id: string;
  email: string;
  displayName: string | null;
  isDemo: boolean;
};

type Step = {
  id: string;
  content: string;
  done: boolean;
  position: number;
};

type FocusTask = {
  id: string;
  title: string;
  whyItMatters: string | null;
  encouragement: string | null;
  emotionalTone: string | null;
  otherTasks: string[];
  steps: Step[];
};

type ReflectionState = {
  count: number;
  latest: {
    id: string;
    summary: string | null;
    carryForward: string | null;
    createdAt: string;
  } | null;
};

type AppState = {
  task: FocusTask | null;
  reflection: ReflectionState;
};

type Config = {
  googleOAuthClientId: string | null;
  geminiConfigured: boolean;
  model: string;
};

type Screen = "landing" | "signin" | "capture" | "focus" | "reflect";
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
          }) => void;
          renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Request failed.");
  }

  return data;
}

const supportLines = [
  "Start with the pile. The system can hold the shape.",
  "You are not behind. You are returning.",
  "One honest next move beats a perfect plan.",
  "Momentum can restart from a sentence.",
  "Let the dump be messy. Relief comes after capture.",
];

const featureCards = [
  {
    title: "Brain Dump",
    icon: Sparkles,
    copy: "Clear the noise instantly with capture that does not ask you to organize first.",
  },
  {
    title: "AI Triage",
    icon: Stars,
    copy: "Turn a messy dump into one aligned focus, with scope that can change when needed.",
  },
  {
    title: "Tiny Step Builder",
    icon: CheckCircle2,
    copy: "Break overwhelming work into small moves that can actually happen today.",
  },
  {
    title: "Page Agents",
    icon: Bot,
    copy: "Each screen has a role-specific assistant with only the context it needs.",
  },
];

export function App() {
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<Screen>("landing");
  const [dumpText, setDumpText] = useState("");
  const [reflectionAnswers, setReflectionAnswers] = useState({
    tried: "",
    hard: "",
    proud: "",
    carry: "Quiet Focus",
  });
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "I am tuned to this screen. Ask me to guide, rewrite, shrink, or adjust.",
    },
  ]);
  const supportLine =
    supportLines[(dumpText.length + 2) % supportLines.length] ??
    "Start with the pile. The system can hold the shape.";

  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<Config>("/api/config"),
  });
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api<{ user: User | null }>("/api/me"),
  });
  const stateQuery = useQuery({
    queryKey: ["state"],
    enabled: Boolean(meQuery.data?.user),
    queryFn: () => api<AppState>("/api/state"),
  });

  const user = meQuery.data?.user ?? null;
  const task = stateQuery.data?.task ?? null;

  useEffect(() => {
    if (meQuery.isLoading || stateQuery.isLoading) {
      return;
    }

    if (!user) {
      setScreen((current) => (current === "landing" ? "landing" : "signin"));
      return;
    }

    if (task && (screen === "landing" || screen === "signin")) {
      setScreen("focus");
      return;
    }

    if (screen === "signin" || screen === "landing") {
      setScreen("capture");
    }
  }, [meQuery.isLoading, screen, stateQuery.isLoading, task, user]);

  const demoMutation = useMutation({
    mutationFn: () => api<{ user: User }>("/api/auth/demo", { method: "POST", body: "{}" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      setScreen("capture");
    },
  });

  const googleMutation = useMutation({
    mutationFn: (credential: string) =>
      api<{ user: User }>("/api/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => api<{ ok: boolean }>("/api/logout", { method: "POST", body: "{}" }),
    onSuccess: async () => {
      queryClient.setQueryData(["state"], { task: null, reflection: { count: 0, latest: null } });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      setScreen("signin");
    },
  });

  const triageMutation = useMutation({
    mutationFn: (text: string) =>
      api<{ task: FocusTask }>("/api/triage", {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<AppState | undefined>(["state"], (current) => ({
        reflection: current?.reflection ?? { count: 0, latest: null },
        task: data.task,
      }));
      setScreen("focus");
    },
  });

  const reflectionMutation = useMutation({
    mutationFn: () =>
      api<{
        reflection: ReflectionState["latest"];
      }>("/api/reflect", {
        method: "POST",
        body: JSON.stringify({
          answers: {
            tried: reflectionAnswers.tried,
            hard: reflectionAnswers.hard,
            proud: reflectionAnswers.proud,
          },
          carryForward: reflectionAnswers.carry,
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const toggleStepMutation = useMutation({
    mutationFn: ({ stepId, done }: { stepId: string; done: boolean }) =>
      api<{ step: Step }>(`/api/steps/${stepId}`, {
        method: "PATCH",
        body: JSON.stringify({ done }),
      }),
    onMutate: async ({ stepId, done }) => {
      await queryClient.cancelQueries({ queryKey: ["state"] });
      const previous = queryClient.getQueryData<AppState>(["state"]);

      if (previous?.task) {
        queryClient.setQueryData<AppState>(["state"], {
          ...previous,
          task: {
            ...previous.task,
            steps: previous.task.steps.map((step) =>
              step.id === stepId ? { ...step, done } : step,
            ),
          },
        });
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["state"], context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const currentAgent: Screen = task && screen === "focus" ? "focus" : screen;

  return (
    <div className="min-h-screen overflow-x-hidden text-starlight">
      <TopNav
        user={user}
        onTry={() => setScreen(user ? (task ? "focus" : "capture") : "signin")}
        onLogout={() => logoutMutation.mutate()}
      />

      <Landing onTry={() => setScreen(user ? (task ? "focus" : "capture") : "signin")} />

      <section id="app" className="mx-auto w-[min(1120px,calc(100vw-32px))] py-20">
        <div className="mx-auto mb-8 max-w-[720px] text-center">
          <h2 className="font-serif text-4xl text-indigo-soft md:text-5xl">Try the loop now.</h2>
          <p className="mt-4 text-mist">
            Dump the mess, get one main quest, and let the page agent shrink the plan when it feels
            too large.
          </p>
        </div>

        {!user && screen !== "landing" ? (
          <SigninPanel
            config={configQuery.data}
            demoPending={demoMutation.isPending}
            googlePending={googleMutation.isPending}
            error={demoMutation.error?.message ?? googleMutation.error?.message}
            onDemo={() => demoMutation.mutate()}
            onGoogleCredential={(credential) => googleMutation.mutate(credential)}
          />
        ) : null}

        {user && screen === "capture" ? (
          <CapturePanel
            dumpText={dumpText}
            error={triageMutation.error?.message}
            loading={triageMutation.isPending}
            line={supportLine}
            model={configQuery.data?.model ?? "gemini-2.5-flash"}
            user={user}
            onChange={setDumpText}
            onSubmit={() => triageMutation.mutate(dumpText)}
            onLogout={() => logoutMutation.mutate()}
          />
        ) : null}

        {user && screen === "focus" && task ? (
          <FocusPanel
            task={task}
            user={user}
            onNewDump={() => setScreen("capture")}
            onToggleStep={(stepId, done) => toggleStepMutation.mutate({ stepId, done })}
            onLogout={() => logoutMutation.mutate()}
          />
        ) : null}

        {user && screen === "reflect" ? (
          <ReflectPanel
            answers={reflectionAnswers}
            error={reflectionMutation.error?.message}
            latest={stateQuery.data?.reflection.latest ?? null}
            loading={reflectionMutation.isPending}
            reflectionCount={stateQuery.data?.reflection.count ?? 0}
            user={user}
            onAnswers={setReflectionAnswers}
            onLogout={() => logoutMutation.mutate()}
            onSubmit={() => reflectionMutation.mutate()}
          />
        ) : null}
      </section>

      <FinalCta onTry={() => setScreen(user ? (task ? "focus" : "capture") : "signin")} />

      <AgentDrawer
        agent={currentAgent}
        chatOpen={chatOpen}
        dumpText={dumpText}
        messages={chatMessages}
        task={task}
        user={user}
        onApplyCaptureText={setDumpText}
        onMessages={setChatMessages}
        onOpenChange={setChatOpen}
        onRoute={(route) => {
          if (route === "capture") {
            setScreen(user ? "capture" : "signin");
          }
        }}
      />
      {user ? <BottomNav screen={screen} task={task} onScreen={setScreen} /> : null}
    </div>
  );
}

function TopNav({
  onLogout,
  onTry,
  user,
}: {
  user: User | null;
  onLogout: () => void;
  onTry: () => void;
}) {
  return (
    <nav className="sticky top-0 z-30 border-white/10 border-b bg-void/80 backdrop-blur-xl">
      <div className="mx-auto flex min-h-16 w-[min(720px,calc(100vw-48px))] items-center justify-between gap-5">
        <a className="font-serif text-3xl text-starlight" href="/">
          Starflow
        </a>
        <div className="hidden items-center gap-7 text-mist text-sm md:flex">
          <a className="border-starlight border-b pb-1 text-starlight" href="#method">
            Method
          </a>
          <a href="#features">Features</a>
          <a href="#app">Try it</a>
        </div>
        {user ? (
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-dim text-sm"
            onClick={onLogout}
          >
            <LogOut size={16} />
            {user.isDemo ? "Demo" : (user.displayName ?? user.email)}
          </button>
        ) : (
          <button
            type="button"
            className="button-glow inline-flex items-center gap-2 rounded-full bg-indigo-deep px-5 py-2.5 font-bold text-indigo-soft"
            onClick={onTry}
          >
            Begin Ritual
          </button>
        )}
      </div>
    </nav>
  );
}

function Landing({ onTry }: { onTry: () => void }) {
  return (
    <main>
      <section className="hero-backdrop relative grid min-h-[760px] place-items-center px-6 py-28 text-center opacity-95">
        <div className="mx-auto max-w-[720px]">
          <h1 className="bg-gradient-to-br from-starlight to-indigo-soft bg-clip-text font-serif font-semibold text-5xl text-transparent leading-tight md:text-7xl">
            Turn scattered thoughts into steady flow.
          </h1>
          <p className="mx-auto mt-6 max-w-[620px] text-lg text-mist leading-8">
            Starflow is an AI companion for ADHD minds, helping you capture everything racing
            through your brain, choose what matters now, and build self-trust one small step at a
            time.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-4 md:flex-row">
            <button
              type="button"
              className="button-glow inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft/40 px-8 py-4 font-bold text-indigo-soft"
              onClick={onTry}
            >
              <Sparkles size={18} />
              Try the Starflow loop
            </button>
            <a
              className="button-glow inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/5 px-8 py-4 font-bold text-starlight"
              href="#method"
            >
              Watch the method
              <ArrowRight size={18} />
            </a>
          </div>
        </div>
      </section>

      <section className="mx-auto w-[min(720px,calc(100vw-48px))] py-16">
        <div className="glass rounded-[2rem] p-8 text-center md:p-11">
          <h2 className="font-serif text-3xl text-indigo-soft md:text-4xl">
            For minds that move faster than life can organize.
          </h2>
          <p className="mt-6 text-mist leading-8">
            Your brain is a constellation of hundreds of sparks: brilliant ideas, urgent tasks, and
            raw emotions all firing at once.
          </p>
          <p className="mt-6 font-semibold text-lg text-starlight italic">
            "You did not fail. Your brain is not broken."
          </p>
        </div>
      </section>

      <section id="method" className="mx-auto w-[min(720px,calc(100vw-48px))] py-16">
        <h2 className="text-center font-serif text-4xl text-indigo-soft">
          Scatter, Flow, Reflect.
        </h2>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {["Scatter: write the pile", "Flow: get one quest", "Focus: shrink with chat"].map(
            (label) => (
              <div className="glass rounded-[2rem] p-6 text-mist" key={label}>
                {label}
              </div>
            ),
          )}
        </div>
      </section>

      <section id="features" className="mx-auto w-[min(720px,calc(100vw-48px))] py-16">
        <h2 className="text-center font-serif text-4xl text-indigo-soft">
          Designed for executive function.
        </h2>
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {featureCards.map((feature) => (
            <article className="glass rounded-[2rem] p-7" key={feature.title}>
              <feature.icon className="mb-4 text-indigo-soft" size={24} />
              <h3 className="font-bold text-starlight text-lg">{feature.title}</h3>
              <p className="mt-3 text-mist text-sm leading-6">{feature.copy}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function SigninPanel({
  config,
  demoPending,
  error,
  googlePending,
  onDemo,
  onGoogleCredential,
}: {
  config: Config | undefined;
  demoPending: boolean;
  error: string | undefined;
  googlePending: boolean;
  onDemo: () => void;
  onGoogleCredential: (credential: string) => void;
}) {
  const googleButtonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!config?.googleOAuthClientId || !googleButtonRef.current) {
      return;
    }

    const renderButton = () => {
      if (!window.google || !googleButtonRef.current) {
        return;
      }

      window.google.accounts.id.initialize({
        client_id: config.googleOAuthClientId ?? "",
        callback: (response) => {
          if (response.credential) {
            onGoogleCredential(response.credential);
          }
        },
      });
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "filled_black",
        size: "large",
        shape: "pill",
        text: "continue_with",
      });
    };

    if (window.google) {
      renderButton();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = renderButton;
    document.head.appendChild(script);
  }, [config?.googleOAuthClientId, onGoogleCredential]);

  return (
    <div className="glass mx-auto max-w-[720px] rounded-[2rem] p-8 text-center">
      <h3 className="font-serif text-3xl text-indigo-soft">Start where you are.</h3>
      <p className="mx-auto mt-3 max-w-xl text-mist leading-7">
        Demo mode is always available for the hackathon. Google sign-in appears when a client ID is
        configured.
      </p>
      <div className="mt-7 flex flex-col items-center justify-center gap-4">
        {config?.googleOAuthClientId ? <div ref={googleButtonRef} /> : null}
        <button
          type="button"
          className="button-glow inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft/40 px-7 py-3 font-bold text-indigo-soft"
          disabled={demoPending || googlePending}
          onClick={onDemo}
        >
          Continue as demo
        </button>
      </div>
      {error ? <p className="mt-5 text-sm text-red-200">{error}</p> : null}
    </div>
  );
}

function CapturePanel({
  dumpText,
  error,
  line,
  loading,
  model,
  onChange,
  onLogout,
  onSubmit,
  user,
}: {
  dumpText: string;
  error: string | undefined;
  line: string;
  loading: boolean;
  model: string;
  onChange: (value: string) => void;
  onLogout: () => void;
  onSubmit: () => void;
  user: User;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="glass mx-auto max-w-[900px] rounded-[2rem] p-5 md:p-8">
      <PanelHeader user={user} model={model} onLogout={onLogout} />
      <div className="mt-6 grid gap-5 md:grid-cols-[0.9fr_1.1fr]">
        <div>
          <h3 className="font-serif text-4xl text-indigo-soft">What is on your mind?</h3>
          <p className="mt-4 text-mist leading-7">{line}</p>
          <p className="mt-6 text-dim text-sm">
            Cmd/Ctrl+Enter sends this to Starflow. No tags, categories, or maintenance.
          </p>
        </div>
        <div>
          <textarea
            ref={textareaRef}
            className="min-h-72 w-full resize-y rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-starlight outline-none transition focus:border-indigo-soft focus:shadow-[0_0_20px_rgba(190,194,255,0.18)]"
            maxLength={8000}
            placeholder="Type the pile here..."
            value={dumpText}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                onSubmit();
              }
            }}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-dim text-sm">{dumpText.length} / 8000</span>
            <button
              type="button"
              className="button-glow inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft/40 px-7 py-3 font-bold text-indigo-soft"
              disabled={loading || dumpText.trim().length === 0}
              onClick={onSubmit}
            >
              {loading ? "Sorting the noise..." : "Find my focus"}
            </button>
          </div>
          {error ? <p className="mt-4 text-red-200 text-sm">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

function FocusPanel({
  onLogout,
  onNewDump,
  onToggleStep,
  task,
  user,
}: {
  onLogout: () => void;
  onNewDump: () => void;
  onToggleStep: (stepId: string, done: boolean) => void;
  task: FocusTask;
  user: User;
}) {
  return (
    <div className="glass mx-auto max-w-[900px] rounded-[2rem] p-5 md:p-8">
      <PanelHeader user={user} model="focus" onLogout={onLogout} />
      <div className="mt-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="font-bold text-dim text-sm uppercase tracking-[0.18em]">Main quest</p>
            <h3 className="mt-3 font-serif text-4xl text-indigo-soft leading-tight md:text-5xl">
              {task.title}
            </h3>
            {task.whyItMatters ? (
              <p className="mt-4 text-mist leading-7">{task.whyItMatters}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="rounded-full border border-white/10 px-4 py-2 text-mist text-sm"
            onClick={onNewDump}
          >
            New dump
          </button>
        </div>

        <div className="mt-8 grid gap-3">
          {task.steps.map((step) => (
            <button
              type="button"
              className="flex items-center gap-4 rounded-[1.5rem] border border-white/10 bg-white/5 p-4 text-left"
              key={step.id}
              onClick={() => onToggleStep(step.id, !step.done)}
            >
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-full border ${
                  step.done
                    ? "border-gold-soft bg-gold-soft text-black"
                    : "border-indigo-soft text-indigo-soft"
                }`}
              >
                {step.done ? <Check size={17} /> : step.position + 1}
              </span>
              <span className={step.done ? "text-dim line-through" : "text-starlight"}>
                {step.content}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-6 rounded-[1.5rem] border border-gold-soft/20 bg-gold-soft/10 p-4 text-gold-soft">
          {task.encouragement ?? "You only need the next visible move."}
        </div>

        {task.otherTasks.length > 0 ? (
          <p className="mt-4 text-dim text-sm">
            +{task.otherTasks.length} other things noted, set aside for now.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ReflectPanel({
  answers,
  error,
  latest,
  loading,
  onAnswers,
  onLogout,
  onSubmit,
  reflectionCount,
  user,
}: {
  answers: { tried: string; hard: string; proud: string; carry: string };
  error: string | undefined;
  latest: ReflectionState["latest"];
  loading: boolean;
  onAnswers: Dispatch<
    SetStateAction<{ tried: string; hard: string; proud: string; carry: string }>
  >;
  onLogout: () => void;
  onSubmit: () => void;
  reflectionCount: number;
  user: User;
}) {
  const answered = [answers.tried, answers.hard, answers.proud].filter(
    (answer) => answer.trim().length > 0,
  ).length;

  return (
    <div className="mx-auto max-w-[760px]">
      <div className="glass rounded-[2rem] p-5 md:p-8">
        <PanelHeader user={user} model="evening reflection" onLogout={onLogout} />
        <div className="mt-7">
          <p className="font-bold text-indigo-soft text-sm uppercase tracking-[0.18em]">
            Before you sleep
          </p>
          <h3 className="mt-3 font-serif text-4xl text-starlight leading-tight md:text-5xl">
            Let the day settle.
          </h3>
          <p className="mt-4 text-mist leading-7">
            Answer what feels easy. Every new attempt is a star added to your map.
          </p>
        </div>

        <div className="mt-8 grid gap-4">
          <ReflectionPrompt
            icon={<Compass size={20} />}
            label="What did you try today?"
            value={answers.tried}
            onChange={(value) => onAnswers((current) => ({ ...current, tried: value }))}
          />
          <ReflectionPrompt
            icon={<Bot size={20} />}
            label="What felt hard?"
            value={answers.hard}
            onChange={(value) => onAnswers((current) => ({ ...current, hard: value }))}
          />
          <ReflectionPrompt
            icon={<Stars size={20} />}
            label="What are you proud of?"
            value={answers.proud}
            onChange={(value) => onAnswers((current) => ({ ...current, proud: value }))}
          />
          <div className="glass rounded-[1.75rem] p-5">
            <div className="flex items-start gap-4">
              <Moon className="mt-1 text-indigo-soft" size={20} />
              <div className="min-w-0 flex-1">
                <label className="font-serif text-2xl text-starlight" htmlFor="carry-forward">
                  What should carry into tomorrow?
                </label>
                <div className="mt-4 flex flex-wrap gap-2">
                  {["Persistence", "Quiet Focus", "Self-Kindness"].map((chip) => (
                    <button
                      className={`rounded-full border px-4 py-2 text-sm ${
                        answers.carry === chip
                          ? "border-indigo-soft bg-indigo-soft/20 text-indigo-soft"
                          : "border-white/10 bg-white/5 text-mist"
                      }`}
                      key={chip}
                      type="button"
                      onClick={() => onAnswers((current) => ({ ...current, carry: chip }))}
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-white/10 border-t pt-6">
          <div>
            <p className="font-bold text-dim text-xs uppercase tracking-[0.18em]">
              Your evening constellation
            </p>
            <p className="mt-2 text-mist">
              {"★".repeat(Math.min(answered, 4))}
              {"☆".repeat(Math.max(0, 4 - answered))} {answered} of 4 reflections gathered.
            </p>
          </div>
          <button
            className="button-glow rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft/40 px-7 py-3 font-bold text-indigo-soft"
            disabled={loading || answered === 0}
            type="button"
            onClick={onSubmit}
          >
            {loading ? "Gathering..." : "Gather reflection"}
          </button>
        </div>

        {error ? <p className="mt-4 text-red-200 text-sm">{error}</p> : null}
        {latest?.summary ? (
          <div className="mt-6 whitespace-pre-wrap rounded-[1.5rem] border border-gold-soft/20 bg-gold-soft/10 p-5 text-gold-soft leading-7">
            {latest.summary}
          </div>
        ) : null}
        <p className="mt-4 text-dim text-sm">{reflectionCount} saved reflections.</p>
      </div>
    </div>
  );
}

function ReflectionPrompt({
  icon,
  label,
  onChange,
  value,
}: {
  icon: ReactNode;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="glass block rounded-[1.75rem] p-5">
      <span className="flex items-center gap-3 font-serif text-2xl text-starlight">
        <span className="text-indigo-soft">{icon}</span>
        {label}
      </span>
      <textarea
        className="mt-4 min-h-24 w-full resize-y rounded-[1.25rem] border border-white/10 bg-white/5 p-4 text-starlight outline-none transition focus:border-indigo-soft"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function BottomNav({
  onScreen,
  screen,
  task,
}: {
  onScreen: (screen: Screen) => void;
  screen: Screen;
  task: FocusTask | null;
}) {
  const items: Array<{ screen: Screen; label: string; icon: ReactNode; disabled?: boolean }> = [
    { screen: "capture", label: "Scatter", icon: <Sparkles size={19} /> },
    { screen: "focus", label: "Flow", icon: <CheckCircle2 size={19} />, disabled: !task },
    { screen: "reflect", label: "Reflect", icon: <Moon size={19} /> },
  ];

  return (
    <nav className="fixed right-4 bottom-24 left-4 z-30 mx-auto grid max-w-[430px] grid-cols-3 rounded-full border border-white/10 bg-night/90 p-2 shadow-2xl backdrop-blur-xl md:hidden">
      {items.map((item) => (
        <button
          className={`flex flex-col items-center gap-1 rounded-full px-3 py-2 text-xs ${
            screen === item.screen
              ? "bg-indigo-soft/20 text-indigo-soft"
              : "text-dim disabled:opacity-40"
          }`}
          disabled={item.disabled}
          key={item.screen}
          type="button"
          onClick={() => onScreen(item.screen)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function PanelHeader({
  model,
  onLogout,
  user,
}: {
  model: string;
  onLogout: () => void;
  user: User;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-white/10 border-b pb-4">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-full border border-indigo-soft/40 bg-indigo-soft/10 text-indigo-soft">
          S
        </div>
        <div>
          <p className="font-bold">Starflow</p>
          <p className="text-dim text-xs">{model}</p>
        </div>
      </div>
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-dim text-sm"
        onClick={onLogout}
      >
        <LogOut size={16} />
        {user.isDemo ? "Demo" : (user.displayName ?? user.email)}
      </button>
    </div>
  );
}

function AgentDrawer({
  agent,
  chatOpen,
  dumpText,
  messages,
  onApplyCaptureText,
  onMessages,
  onOpenChange,
  onRoute,
  task,
  user,
}: {
  agent: Screen;
  chatOpen: boolean;
  dumpText: string;
  messages: ChatMessage[];
  onApplyCaptureText: (text: string) => void;
  onMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onOpenChange: (open: boolean) => void;
  onRoute: (route: string) => void;
  task: FocusTask | null;
  user: User | null;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const agentLabel = useMemo(
    () =>
      ({
        landing: "Landing concierge",
        signin: "Sign-in guide",
        capture: "Record and translate",
        focus: "Adjustment coach",
        reflect: "Prioritizer",
      })[agent],
    [agent],
  );
  const chatMutation = useMutation({
    mutationFn: (text: string) =>
      api<{
        reply: string;
        uiPatch?: { captureText?: string; route?: string };
        task?: FocusTask | null;
      }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          agent,
          message: text,
          taskId: task?.id,
          uiContext: {
            dumpText,
            task,
            signedIn: Boolean(user),
            isDemo: user?.isDemo ?? false,
          },
        }),
      }),
    onSuccess: (data) => {
      if (data.uiPatch?.captureText) {
        onApplyCaptureText(data.uiPatch.captureText);
      }

      if (data.uiPatch?.route) {
        onRoute(data.uiPatch.route);
      }

      if (data.task) {
        queryClient.setQueryData<AppState | undefined>(["state"], (current) => ({
          reflection: current?.reflection ?? { count: 0, latest: null },
          task: data.task ?? null,
        }));
      }

      onMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", text: data.reply },
      ]);
    },
    onError: (error) => {
      onMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", text: error.message },
      ]);
    },
  });

  function sendMessage() {
    const trimmed = message.trim();

    if (!trimmed || !user) {
      return;
    }

    onMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: trimmed }]);
    setMessage("");
    chatMutation.mutate(trimmed);
  }

  return (
    <>
      <button
        type="button"
        className="button-glow fixed right-5 bottom-5 z-40 grid size-14 place-items-center rounded-full bg-gold-soft text-black shadow-2xl"
        onClick={() => onOpenChange(!chatOpen)}
        aria-label="Open Starflow agent"
      >
        <MessageCircle size={23} />
      </button>
      {chatOpen ? (
        <aside className="fixed right-5 bottom-24 z-40 flex max-h-[70vh] w-[min(420px,calc(100vw-40px))] flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-night/95 shadow-2xl backdrop-blur-xl">
          <div className="border-white/10 border-b p-4">
            <p className="font-bold text-indigo-soft">{agentLabel}</p>
            <p className="text-dim text-xs">Event router context changes with the page.</p>
          </div>
          <div className="grid gap-3 overflow-auto p-4">
            {messages.map((entry) => (
              <div
                className={`max-w-[88%] rounded-2xl p-3 text-sm leading-6 ${
                  entry.role === "user"
                    ? "justify-self-end bg-gold-soft/15 text-starlight"
                    : "justify-self-start bg-indigo-soft/15 text-starlight"
                }`}
                key={entry.id}
              >
                {entry.text}
              </div>
            ))}
          </div>
          <div className="flex gap-2 border-white/10 border-t p-3">
            <input
              className="min-w-0 flex-1 rounded-full border border-white/10 bg-white/5 px-4 text-starlight outline-none"
              disabled={!user || chatMutation.isPending}
              placeholder={user ? "Talk to me..." : "Sign in to chat"}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  sendMessage();
                }
              }}
            />
            <button
              type="button"
              className="rounded-full bg-indigo-deep px-4 font-bold text-indigo-soft"
              disabled={!user || chatMutation.isPending || !message.trim()}
              onClick={sendMessage}
            >
              Send
            </button>
          </div>
        </aside>
      ) : null}
    </>
  );
}

function FinalCta({ onTry }: { onTry: () => void }) {
  return (
    <section className="px-6 py-24 text-center">
      <h2 className="font-serif text-5xl text-starlight">You did not fail.</h2>
      <p className="mt-4 font-serif text-3xl text-mist">Let's find your flow again.</p>
      <button
        type="button"
        className="button-glow mt-9 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft/40 px-8 py-4 font-bold text-indigo-soft"
        onClick={onTry}
      >
        Return to Starflow
      </button>
    </section>
  );
}
