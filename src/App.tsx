import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  Camera,
  Check,
  CheckCircle2,
  Compass,
  Lightbulb,
  LogOut,
  MessageCircle,
  Mic,
  Moon,
  MoreVertical,
  Play,
  Sparkles,
  Stars,
  Zap,
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

type ReflectionEntry = NonNullable<ReflectionState["latest"]>;

type MemoryState = {
  count: number;
  latest: {
    id: string;
    content: string;
    createdAt: string;
  } | null;
};

type CategorizedMemory = {
  id: string;
  content: string;
  createdAt: string;
};

type MemoryCategory = {
  name: string;
  summary: string;
  memories: CategorizedMemory[];
};

type DailyReport = {
  headline: string;
  encouragement: string;
  observations: string[];
  threads: Array<{ label: string; detail: string }>;
  carryForward: string;
};

type AppState = {
  task: FocusTask | null;
  reflection: ReflectionState;
  memory: MemoryState;
};

type Config = {
  googleOAuthClientId: string | null;
  geminiConfigured: boolean;
  model: string;
};

type Screen = "landing" | "signin" | "capture" | "focus" | "reflect" | "thoughts";
type ChatAgent = "landing" | "signin" | "capture" | "focus" | "reflect";
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

function localDayWindow() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export function App() {
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<Screen>(() =>
    window.location.pathname === "/app" ? "signin" : "landing",
  );
  const [dumpText, setDumpText] = useState("");
  const [supportLine] = useState(
    () =>
      supportLines[Math.floor(Math.random() * supportLines.length)] ??
      "Start with the pile. The system can hold the shape.",
  );
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
  const memory = stateQuery.data?.memory ?? { count: 0, latest: null };
  const todayWindow = useMemo(() => localDayWindow(), []);
  const categorizedMemoriesQuery = useQuery({
    queryKey: ["memories", "categorized", user?.id],
    enabled: Boolean(user && screen === "thoughts"),
    queryFn: () =>
      api<{
        total: number;
        categories: MemoryCategory[];
        usedModel: boolean;
        model: string | null;
      }>("/api/memories/categorized"),
  });
  const dailyReportQuery = useQuery({
    queryKey: ["reflect", "report", user?.id, todayWindow.start],
    enabled: Boolean(user && screen === "reflect"),
    queryFn: () =>
      api<{ report: DailyReport; usedModel: boolean; example: boolean }>(
        `/api/reflect/report?since=${encodeURIComponent(todayWindow.start)}&until=${encodeURIComponent(todayWindow.end)}`,
      ),
  });
  const reflectionHistoryQuery = useQuery({
    queryKey: ["reflections", user?.id],
    enabled: Boolean(user && screen === "reflect"),
    queryFn: () => api<{ reflections: ReflectionEntry[] }>("/api/reflections"),
  });

  useEffect(() => {
    const onPopState = () => {
      setScreen(window.location.pathname === "/app" ? (user ? "capture" : "signin") : "landing");
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [user]);

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
      queryClient.setQueryData(["state"], {
        task: null,
        reflection: { count: 0, latest: null },
        memory: { count: 0, latest: null },
      });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      setScreen("signin");
    },
  });

  const memoryMutation = useMutation({
    mutationFn: (text: string) =>
      api<{ memory: MemoryState["latest"]; memoryState: MemoryState }>("/api/memories", {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<AppState | undefined>(["state"], (current) => ({
        reflection: current?.reflection ?? { count: 0, latest: null },
        task: current?.task ?? null,
        memory: data.memoryState,
      }));
      queryClient.invalidateQueries({ queryKey: ["memories", "categorized"] });
      setDumpText("");
    },
  });

  const photoMutation = useMutation({
    mutationFn: (imageDataUrl: string) =>
      api<{
        memory: MemoryState["latest"];
        memoryState: MemoryState;
        note: string;
      }>("/api/capture/photo", {
        method: "POST",
        body: JSON.stringify({ imageDataUrl }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<AppState | undefined>(["state"], (current) => ({
        reflection: current?.reflection ?? { count: 0, latest: null },
        task: current?.task ?? null,
        memory: data.memoryState,
      }));
      queryClient.invalidateQueries({ queryKey: ["memories", "categorized"] });
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
        memory: current?.memory ?? { count: 0, latest: null },
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
            tried: reflectionAnswers.proud ? "Reviewed the daily map" : "",
            hard: "",
            proud: reflectionAnswers.proud,
          },
          carryForward: reflectionAnswers.carry,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["reflections"] });
    },
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

  const currentAgent: ChatAgent =
    screen === "thoughts" ? "capture" : task && screen === "focus" ? "focus" : screen;
  const handleScreen = (nextScreen: Screen) => {
    if (nextScreen === "focus") {
      setScreen("focus");

      if (!task && memory.latest?.content && !triageMutation.isPending) {
        triageMutation.mutate(memory.latest.content);
      }

      return;
    }

    setScreen(nextScreen);
  };
  const enterFlow = () => {
    if (window.location.pathname !== "/app") {
      window.history.pushState(null, "", "/app");
    }
    setScreen(user ? (task ? "focus" : "capture") : "signin");
  };

  return (
    <div className="min-h-screen overflow-x-hidden text-starlight">
      <TopNav user={user} onTry={enterFlow} onLogout={() => logoutMutation.mutate()} />

      {screen === "landing" ? (
        <>
          <Landing onTry={enterFlow} />
          <FinalCta onTry={enterFlow} />
        </>
      ) : (
        <section
          id="app"
          className="mx-auto min-h-[calc(100svh-64px)] w-[min(1120px,calc(100vw-24px))] pt-5 pb-44 md:w-[min(1120px,calc(100vw-32px))] md:py-10"
        >
          {!user ? (
            <div className="mx-auto mb-6 hidden max-w-[720px] text-center md:block">
              <h2 className="font-serif text-4xl text-indigo-soft md:text-5xl">
                Try the loop now.
              </h2>
              <p className="mt-4 text-mist">
                Move between Scatter, Flow, and Reflect without losing your place.
              </p>
            </div>
          ) : null}

          {user ? (
            <DesktopModeSwitcher
              memoryCount={memory.count}
              screen={screen}
              onScreen={handleScreen}
            />
          ) : null}

          {!user ? (
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
              error={memoryMutation.error?.message ?? photoMutation.error?.message}
              line={supportLine}
              loading={memoryMutation.isPending}
              memory={memory}
              model={configQuery.data?.model ?? "gemini-3.5-flash"}
              photoLoading={photoMutation.isPending}
              user={user}
              onChange={setDumpText}
              onPhotoCapture={(imageDataUrl) => photoMutation.mutate(imageDataUrl)}
              onSubmit={() => memoryMutation.mutate(dumpText)}
              onViewThoughts={() => setScreen("thoughts")}
              onLogout={() => logoutMutation.mutate()}
            />
          ) : null}

          {user && screen === "thoughts" ? (
            <ThoughtsPanel
              categories={categorizedMemoriesQuery.data?.categories ?? []}
              error={categorizedMemoriesQuery.error?.message}
              loading={categorizedMemoriesQuery.isLoading}
              total={categorizedMemoriesQuery.data?.total ?? 0}
              usedModel={categorizedMemoriesQuery.data?.usedModel ?? false}
              onBack={() => setScreen("capture")}
              onStartThought={(content) => triageMutation.mutate(content)}
              startingFlow={triageMutation.isPending}
            />
          ) : null}

          {user && screen === "focus" && task ? (
            <FocusPanel
              task={task}
              onChooseThought={() => setScreen("thoughts")}
              onReflect={() => setScreen("reflect")}
              user={user}
              onNewDump={() => setScreen("capture")}
              onToggleStep={(stepId, done) => toggleStepMutation.mutate({ stepId, done })}
              onLogout={() => logoutMutation.mutate()}
            />
          ) : null}

          {user && screen === "focus" && !task ? (
            <FlowStartPanel
              error={triageMutation.error?.message}
              loading={triageMutation.isPending}
              memory={memory}
              onBack={() => setScreen("capture")}
              onStart={() => {
                if (memory.latest?.content) {
                  triageMutation.mutate(memory.latest.content);
                }
              }}
              user={user}
            />
          ) : null}

          {user && screen === "reflect" ? (
            <ReflectPanel
              answers={reflectionAnswers}
              error={reflectionMutation.error?.message}
              latest={stateQuery.data?.reflection.latest ?? null}
              report={dailyReportQuery.data?.report ?? null}
              reportLoading={dailyReportQuery.isLoading}
              history={reflectionHistoryQuery.data?.reflections ?? []}
              loading={reflectionMutation.isPending}
              reflectionCount={stateQuery.data?.reflection.count ?? 0}
              user={user}
              onAnswers={setReflectionAnswers}
              onLogout={() => logoutMutation.mutate()}
              onSubmit={() => reflectionMutation.mutate()}
            />
          ) : null}
        </section>
      )}

      <AgentDrawer
        agent={currentAgent}
        chatOpen={chatOpen}
        dumpText={dumpText}
        messages={chatMessages}
        task={task}
        user={user}
        onApplyCaptureText={setDumpText}
        onApplyCarryForward={(value) =>
          setReflectionAnswers((current) => ({ ...current, carry: value }))
        }
        onMessages={setChatMessages}
        onOpenChange={setChatOpen}
        onRoute={(route) => {
          if (route === "capture") {
            setScreen(user ? "capture" : "signin");
          }
          if (route === "focus") {
            setScreen(user ? "focus" : "signin");
          }
        }}
      />
      {user && screen !== "landing" ? <BottomNav screen={screen} onScreen={handleScreen} /> : null}
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
          <button type="button" onClick={onTry}>
            Try it
          </button>
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
      <section className="hero-backdrop relative grid min-h-[calc(100svh-64px)] place-items-center px-6 py-14 text-center opacity-95 md:min-h-[760px] md:py-28">
        <div className="mx-auto max-w-[720px]">
          <div className="mx-auto mb-8 grid size-20 place-items-center rounded-full border border-indigo-soft/20 bg-indigo-soft/10 md:hidden">
            <Sparkles className="text-indigo-soft" size={34} />
          </div>
          <h1 className="bg-gradient-to-br from-starlight to-indigo-soft bg-clip-text font-serif font-semibold text-4xl text-transparent leading-tight md:text-7xl">
            <span className="md:hidden">Welcome to Starflow</span>
            <span className="hidden md:inline">Turn scattered thoughts into steady flow.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-[620px] text-mist text-xl leading-9 md:text-lg md:leading-8">
            <span className="md:hidden">
              A gentle place to capture your thoughts, find your next step, and return to yourself.
            </span>
            <span className="hidden md:inline">
              Starflow is an AI companion for ADHD minds, helping you capture everything racing
              through your brain, choose what matters now, and build self-trust one small step at a
              time.
            </span>
          </p>
          <div className="mt-9 flex flex-col justify-center gap-4 md:flex-row">
            <button
              type="button"
              className="button-glow inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft/60 px-10 py-4 font-bold text-indigo-soft"
              onClick={onTry}
            >
              <Sparkles size={18} />
              <span className="md:hidden">Begin gently</span>
              <span className="hidden md:inline">Try the Starflow loop</span>
            </button>
            <a
              className="hidden items-center justify-center gap-2 rounded-full border border-white/10 bg-white/5 px-8 py-4 font-bold text-starlight button-glow md:inline-flex"
              href="#method"
            >
              Watch the method
              <ArrowRight size={18} />
            </a>
          </div>
        </div>
      </section>

      <section className="mx-auto hidden w-[min(720px,calc(100vw-48px))] py-16 md:block">
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

      <section
        id="method"
        className="mx-auto hidden w-[min(720px,calc(100vw-48px))] py-16 md:block"
      >
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

      <section
        id="features"
        className="mx-auto hidden w-[min(720px,calc(100vw-48px))] py-16 md:block"
      >
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
  memory,
  model,
  onChange,
  onLogout,
  onPhotoCapture,
  onSubmit,
  onViewThoughts,
  photoLoading,
  user,
}: {
  dumpText: string;
  error: string | undefined;
  line: string;
  loading: boolean;
  memory: MemoryState;
  model: string;
  onChange: (value: string) => void;
  onLogout: () => void;
  onPhotoCapture: (imageDataUrl: string) => void;
  onSubmit: () => void;
  onViewThoughts: () => void;
  photoLoading: boolean;
  user: User;
}) {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handlePhotoFile = (file: File | undefined) => {
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        onPhotoCapture(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="mx-auto max-w-[430px] md:max-w-[900px]">
      <div className="mb-4 flex items-center justify-between md:mb-6">
        <div className="flex items-center gap-3">
          <Sparkles className="text-indigo-soft" size={24} />
          <h2 className="font-serif text-3xl text-starlight md:text-4xl">Starflow</h2>
        </div>
        <button
          type="button"
          className="rounded-full border border-white/10 px-3 py-2 text-dim text-xs"
          onClick={onLogout}
        >
          {user.isDemo ? "Demo" : "Account"}
        </button>
      </div>

      <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-indigo-soft/10 p-4 md:rounded-[2.5rem] md:p-8">
        <div className="pointer-events-none absolute -right-24 -top-20 size-72 rounded-full bg-indigo-soft/20 blur-3xl" />
        <div className="relative">
          <p className="font-bold text-indigo-soft text-[0.68rem] uppercase tracking-[0.18em] md:text-xs md:tracking-[0.22em]">
            Scatter
          </p>
          <h3 className="mt-3 font-serif text-3xl text-starlight leading-tight md:mt-6 md:text-5xl">
            What's on your mind?
          </h3>
          <p className="mt-2 text-mist text-sm leading-6 md:mt-4 md:text-base md:leading-7">
            {line} Save the thought here. Flow will turn it into action when you are ready.
          </p>
        </div>
      </div>

      <div className="mt-5 hidden gap-3 md:grid">
        {[
          { icon: Lightbulb, text: "I want to build an app.", meta: "Creative spark" },
          { icon: Compass, text: "I forgot to reply to someone.", meta: "Life admin" },
          { icon: Bot, text: "I feel overwhelmed.", meta: "Emotional spark" },
        ].map((spark) => (
          <button
            type="button"
            className="glass flex items-center gap-4 rounded-[2rem] p-4 text-left transition hover:border-indigo-soft/40"
            key={spark.text}
            onClick={() => onChange(spark.text)}
          >
            <div className="grid size-14 place-items-center rounded-full bg-indigo-soft/20 text-indigo-soft">
              <spark.icon size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-starlight">"{spark.text}"</p>
              <p className="mt-1 text-dim text-sm">{spark.meta}</p>
            </div>
            <MoreVertical className="text-dim" size={18} />
          </button>
        ))}
      </div>

      <div className="mt-4 glass rounded-[1.75rem] p-3 md:mt-5 md:rounded-[2rem] md:p-4">
        <div className="relative">
          <textarea
            ref={textareaRef}
            className="min-h-44 w-full resize-y rounded-[1.35rem] border border-white/10 bg-white/5 p-4 text-starlight outline-none transition focus:border-indigo-soft focus:shadow-[0_0_20px_rgba(190,194,255,0.18)] md:min-h-32 md:rounded-[1.5rem] md:p-5"
            maxLength={8000}
            placeholder="Type a spark of thought..."
            value={dumpText}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                onSubmit();
              }
            }}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-dim text-sm">{dumpText.length} / 8000</span>
          <span className="text-dim text-xs">{model}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <input
            ref={photoInputRef}
            type="file"
            className="hidden"
            accept="image/png,image/jpeg,image/webp"
            capture="environment"
            onChange={(event) => {
              handlePhotoFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-3 font-bold text-dim text-sm"
            disabled
            title="Voice capture is a demo placeholder."
          >
            <Mic size={17} />
            Voice
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-indigo-soft/25 bg-indigo-soft/10 px-4 py-3 font-bold text-indigo-soft text-sm disabled:cursor-not-allowed disabled:opacity-60"
            disabled={photoLoading}
            onClick={() => photoInputRef.current?.click()}
          >
            <Camera size={17} />
            {photoLoading ? "Reading..." : "Photo"}
          </button>
        </div>
        <button
          type="button"
          className="button-glow mt-4 inline-flex w-full items-center justify-center gap-3 rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft px-7 py-4 font-bold text-indigo-deep md:py-5"
          disabled={loading || dumpText.trim().length === 0}
          onClick={onSubmit}
        >
          <Zap size={20} />
          {loading ? "Saving..." : "Save to memory"}
        </button>
        {memory.latest ? (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-center text-sm">
            <span className="text-dim">
              {memory.count} thought{memory.count === 1 ? "" : "s"} remembered.
            </span>
            <button
              type="button"
              className="font-bold text-indigo-soft hover:text-starlight"
              onClick={onViewThoughts}
            >
              View categorized thoughts
            </button>
          </div>
        ) : null}
        {error ? <p className="mt-4 text-red-200 text-sm">{error}</p> : null}
      </div>
    </div>
  );
}

function ThoughtsPanel({
  categories,
  error,
  loading,
  onBack,
  onStartThought,
  startingFlow,
  total,
  usedModel,
}: {
  categories: MemoryCategory[];
  error: string | undefined;
  loading: boolean;
  onBack: () => void;
  onStartThought: (content: string) => void;
  startingFlow: boolean;
  total: number;
  usedModel: boolean;
}) {
  return (
    <div className="mx-auto max-w-[900px]">
      <div className="glass rounded-[2rem] p-5 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3 border-white/10 border-b pb-4">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-full border border-indigo-soft/40 bg-indigo-soft/10 text-indigo-soft">
              <Sparkles size={18} />
            </div>
            <div>
              <p className="font-bold">Scatter thoughts</p>
              <p className="text-dim text-xs">
                {usedModel ? "Categorized by Gemini" : "Grouped locally"}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-full border border-white/10 px-4 py-2 text-dim text-sm"
            onClick={onBack}
          >
            Back to Scatter
          </button>
        </div>

        <div className="mt-7">
          <p className="font-bold text-indigo-soft text-sm uppercase tracking-[0.18em]">
            Thought map
          </p>
          <h3 className="mt-3 font-serif text-4xl text-starlight leading-tight md:text-5xl">
            What you have been carrying.
          </h3>
          <p className="mt-4 text-mist leading-7">
            {total > 0
              ? `${total} saved Scatter thought${total === 1 ? "" : "s"}, grouped into patterns.`
              : "Save a Scatter thought first, then this page will organize it into patterns."}
          </p>
        </div>

        {loading ? <p className="mt-8 text-mist">Categorizing your thoughts...</p> : null}
        {error ? <p className="mt-6 text-red-200 text-sm">{error}</p> : null}

        {!loading && categories.length > 0 ? (
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {categories.map((category) => (
              <section
                className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5"
                key={category.name}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-serif text-2xl text-starlight">{category.name}</h4>
                    <p className="mt-2 text-dim text-sm leading-6">{category.summary}</p>
                  </div>
                  <span className="rounded-full bg-indigo-soft/15 px-3 py-1 text-indigo-soft text-xs">
                    {category.memories.length}
                  </span>
                </div>
                <div className="mt-4 grid gap-3">
                  {category.memories.map((memory) => (
                    <article
                      className="rounded-[1rem] border border-white/10 bg-night/60 p-3"
                      key={memory.id}
                    >
                      <p className="text-mist text-sm leading-6">{memory.content}</p>
                      <button
                        type="button"
                        className="mt-3 inline-flex items-center gap-2 rounded-full border border-indigo-soft/30 bg-indigo-soft/10 px-3 py-1.5 font-bold text-indigo-soft text-xs disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={startingFlow}
                        onClick={() => onStartThought(memory.content)}
                      >
                        <ArrowRight size={13} />
                        {startingFlow ? "Starting..." : "Start Flow"}
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {!loading && categories.length === 0 ? (
          <div className="mt-8 rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-mist">
            Nothing saved yet. Scatter is the place to drop thoughts before they need to become
            action.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FlowStartPanel({
  error,
  loading,
  memory,
  onBack,
  onStart,
  user,
}: {
  error: string | undefined;
  loading: boolean;
  memory: MemoryState;
  onBack: () => void;
  onStart: () => void;
  user: User;
}) {
  return (
    <div className="mx-auto max-w-[430px] md:max-w-[760px]">
      <div className="glass rounded-[2rem] p-5 md:p-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-full bg-indigo-soft/20 text-indigo-soft">
              <Stars size={18} />
            </div>
            <div>
              <p className="font-bold">Flow</p>
              <p className="text-dim text-xs">flow triage</p>
            </div>
          </div>
          <span className="rounded-full border border-white/10 px-3 py-1.5 text-dim text-xs">
            {user.isDemo ? "Demo" : "Account"}
          </span>
        </div>
        <p className="mt-7 font-bold text-indigo-soft text-sm uppercase tracking-[0.18em]">Flow</p>
        <h3 className="mt-3 font-serif text-4xl text-starlight leading-tight md:text-5xl">
          Choose one saved thought.
        </h3>
        <p className="mt-4 text-mist leading-7">
          Flow uses Gemini to turn the latest Scatter memory into one main focus and ordered tiny
          steps.
        </p>

        {memory.latest ? (
          <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
            <p className="font-bold text-dim text-xs uppercase tracking-[0.14em]">
              Latest scatter memory
            </p>
            <p className="mt-2 text-starlight leading-6">{memory.latest.content}</p>
            <p className="mt-3 text-dim text-sm">
              {memory.count} thought{memory.count === 1 ? "" : "s"} remembered
            </p>
          </div>
        ) : (
          <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
            <p className="text-mist leading-6">
              No Scatter memory yet. Save one thought first, then come back to Flow.
            </p>
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            className="button-glow inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft px-6 py-3 font-bold text-indigo-deep disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!memory.latest || loading}
            onClick={onStart}
          >
            <Zap size={18} />
            {loading ? "Finding your flow..." : "Triage latest memory"}
          </button>
          <button
            type="button"
            className="rounded-full border border-white/10 px-6 py-3 font-bold text-mist"
            onClick={onBack}
          >
            Back to Scatter
          </button>
        </div>
        {error ? <p className="mt-4 text-red-200 text-sm">{error}</p> : null}
      </div>
    </div>
  );
}

function FocusPanel({
  onChooseThought,
  onLogout,
  onNewDump,
  onReflect,
  onToggleStep,
  task,
  user,
}: {
  onChooseThought: () => void;
  onLogout: () => void;
  onNewDump: () => void;
  onReflect: () => void;
  onToggleStep: (stepId: string, done: boolean) => void;
  task: FocusTask;
  user: User;
}) {
  const firstOpenStep = task.steps.find((step) => !step.done);
  const allStepsDone = task.steps.length > 0 && task.steps.every((step) => step.done);

  return (
    <div className="mx-auto max-w-[430px] md:max-w-[760px]">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-bold text-indigo-soft text-xs uppercase tracking-[0.18em]">Focus mode</p>
        <button
          type="button"
          className="rounded-full border border-white/10 px-3 py-1.5 text-dim text-xs"
          onClick={onLogout}
        >
          {user.isDemo ? "Demo" : "Account"}
        </button>
      </div>

      <div className="glass relative rounded-[2rem] p-5 md:rounded-[2.5rem] md:p-6">
        <span className="-top-3.5 absolute rounded-full border border-white/10 bg-void px-4 py-1.5 font-bold text-dim text-xs uppercase tracking-[0.12em]">
          Main focus today
        </span>
        <div className="mt-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-serif text-2xl text-starlight leading-tight md:text-3xl">
              {task.title}
            </h3>
            {task.whyItMatters ? (
              <p className="mt-2 text-mist text-sm leading-6">{task.whyItMatters}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-indigo-soft/20 bg-indigo-soft/10 text-indigo-soft"
            onClick={onNewDump}
            aria-label="New dump"
          >
            <MoreVertical size={18} />
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-indigo-soft/25 bg-indigo-soft/10 px-3 py-1.5 font-bold text-indigo-soft text-xs"
            onClick={onChooseThought}
          >
            <Sparkles size={13} />
            Choose another thought
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 font-bold text-dim text-xs"
            onClick={onNewDump}
          >
            <Zap size={13} />
            New Scatter
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-2">
        {task.steps.map((step) => {
          const isNext = step.id === firstOpenStep?.id;
          return (
            <button
              type="button"
              key={step.id}
              className={`flex items-center gap-3 rounded-[1.25rem] p-4 text-left transition ${
                isNext
                  ? "border border-gold-soft/40 bg-gold-soft/8 shadow-[0_0_18px_rgba(233,195,73,0.12)]"
                  : "border border-white/10 bg-white/5"
              }`}
              onClick={() => onToggleStep(step.id, !step.done)}
            >
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-full border text-xs font-bold ${
                  step.done
                    ? "border-gold-soft bg-gold-soft text-black"
                    : isNext
                      ? "border-gold-soft text-gold-soft"
                      : "border-indigo-soft/60 text-indigo-soft"
                }`}
              >
                {step.done ? <Check size={14} /> : step.position + 1}
              </span>
              <span
                className={`flex-1 text-sm leading-5 ${step.done ? "text-dim line-through" : isNext ? "font-semibold text-starlight" : "text-mist"}`}
              >
                {step.content}
              </span>
              {isNext && !step.done ? (
                <span className="shrink-0 grid size-8 place-items-center rounded-full bg-indigo-soft text-indigo-deep shadow-[0_0_14px_rgba(190,194,255,0.35)]">
                  <Play size={14} fill="currentColor" />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {allStepsDone ? (
        <div className="mt-4 rounded-[1.5rem] border border-gold-soft/30 bg-gold-soft/10 p-5">
          <p className="flex items-center gap-2 font-bold text-gold-soft text-sm uppercase tracking-[0.14em]">
            <CheckCircle2 size={16} />
            Flow complete
          </p>
          <p className="mt-3 text-starlight leading-6">
            The tiny steps are done. Let the win land before choosing more.
          </p>
          <button
            type="button"
            className="button-glow mt-4 rounded-full bg-gold-soft px-6 py-2.5 font-bold text-black text-sm"
            onClick={onReflect}
          >
            Reflect
          </button>
        </div>
      ) : null}

      <div className="mt-5 text-center">
        <p className="mx-auto max-w-xs text-dim text-sm leading-6">
          {task.encouragement ?? "Perfection is the enemy of the first draft. Just flow."}
        </p>
        {task.otherTasks.length > 0 ? (
          <p className="mt-2 text-dim text-xs">
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
  history,
  latest,
  loading,
  onAnswers,
  onLogout,
  onSubmit,
  report,
  reportLoading,
  reflectionCount,
  user,
}: {
  answers: { tried: string; hard: string; proud: string; carry: string };
  error: string | undefined;
  history: ReflectionEntry[];
  latest: ReflectionState["latest"];
  loading: boolean;
  onAnswers: Dispatch<
    SetStateAction<{ tried: string; hard: string; proud: string; carry: string }>
  >;
  onLogout: () => void;
  onSubmit: () => void;
  report: DailyReport | null;
  reportLoading: boolean;
  reflectionCount: number;
  user: User;
}) {
  const reflectionSignals = ["I showed up", "I made something visible", "I came back gently"];
  const carryChoices = ["Showing up counts", "Quiet Focus", "Self-Kindness", "One next step"];
  const historyByDay = useMemo(() => {
    const groups = new Map<string, ReflectionEntry[]>();

    for (const reflection of history) {
      const day = new Date(reflection.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        weekday: "short",
      });
      groups.set(day, [...(groups.get(day) ?? []), reflection]);
    }

    return [...groups.entries()];
  }, [history]);
  const activeReport =
    report ??
    ({
      headline: "You showed up today.",
      encouragement:
        "You did great. Even opening this page counts as returning to yourself with care.",
      observations: [
        "Scatter gives your thoughts somewhere to land.",
        "Flow can turn one saved thought into a lighter next step.",
        "Reflect is here to notice effort, not grade output.",
      ],
      threads: [
        {
          label: "Kind reframe",
          detail: "You are not starting over; you are returning.",
        },
      ],
      carryForward: "Showing up counts",
    } satisfies DailyReport);

  return (
    <div className="mx-auto max-w-[760px]">
      <div className="glass rounded-[2rem] p-5 md:p-8">
        <PanelHeader user={user} model="evening reflection" onLogout={onLogout} />
        <div className="mt-7">
          <p className="font-bold text-indigo-soft text-sm uppercase tracking-[0.18em]">
            Before you sleep
          </p>
          <h3 className="mt-3 font-serif text-4xl text-starlight leading-tight md:text-5xl">
            {reportLoading ? "Mapping the day..." : activeReport.headline}
          </h3>
          <p className="mt-4 text-mist leading-7">{activeReport.encouragement}</p>
        </div>

        <div className="mt-8 grid gap-4">
          <div className="rounded-[1.5rem] border border-gold-soft/20 bg-gold-soft/10 p-5">
            <p className="font-bold text-gold-soft text-xs uppercase tracking-[0.16em]">
              What I am noticing
            </p>
            <ul className="mt-4 grid gap-3 text-starlight leading-6">
              {activeReport.observations.map((item) => (
                <li className="flex gap-3" key={item}>
                  <Stars className="mt-1 shrink-0 text-gold-soft" size={15} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {activeReport.threads.map((thread) => (
              <div
                className="rounded-[1.25rem] border border-white/10 bg-white/5 p-4"
                key={thread.label}
              >
                <p className="font-bold text-indigo-soft">{thread.label}</p>
                <p className="mt-2 text-mist text-sm leading-6">{thread.detail}</p>
              </div>
            ))}
          </div>

          <div className="glass rounded-[1.75rem] p-5">
            <p className="font-serif text-2xl text-starlight">What should the day remember?</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {reflectionSignals.map((chip) => (
                <button
                  className={`rounded-full border px-4 py-2 text-sm ${
                    answers.proud === chip
                      ? "border-indigo-soft bg-indigo-soft/20 text-indigo-soft"
                      : "border-white/10 bg-white/5 text-mist"
                  }`}
                  key={chip}
                  type="button"
                  onClick={() => onAnswers((current) => ({ ...current, proud: chip }))}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>

          <div className="glass rounded-[1.75rem] p-5">
            <p className="font-serif text-2xl text-starlight">Carry into tomorrow</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {carryChoices.map((chip) => (
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

        <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-white/10 border-t pt-6">
          <div>
            <p className="font-bold text-dim text-xs uppercase tracking-[0.18em]">
              Guided reflection
            </p>
            <p className="mt-2 text-mist">{reflectionCount} saved reflections.</p>
          </div>
          <button
            className="button-glow rounded-full bg-gradient-to-r from-indigo-deep to-indigo-soft/40 px-7 py-3 font-bold text-indigo-soft"
            disabled={loading || reportLoading}
            type="button"
            onClick={onSubmit}
          >
            {loading ? "Saving..." : "Save reflection"}
          </button>
        </div>

        {error ? <p className="mt-4 text-red-200 text-sm">{error}</p> : null}
        {latest?.summary ? (
          <div className="mt-6 whitespace-pre-wrap rounded-[1.5rem] border border-gold-soft/20 bg-gold-soft/10 p-5 text-gold-soft leading-7">
            {latest.summary}
          </div>
        ) : null}

        {historyByDay.length > 0 ? (
          <div className="mt-7 border-white/10 border-t pt-6">
            <p className="font-bold text-indigo-soft text-sm uppercase tracking-[0.18em]">
              Reflection history
            </p>
            <div className="mt-4 grid gap-4">
              {historyByDay.map(([day, entries]) => (
                <section
                  className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4"
                  key={day}
                >
                  <p className="font-bold text-starlight">{day}</p>
                  <div className="mt-3 grid gap-3">
                    {entries.map((entry) => (
                      <article
                        className="rounded-[1rem] border border-white/10 bg-night/50 p-3 text-sm"
                        key={entry.id}
                      >
                        {entry.summary ? (
                          <p className="whitespace-pre-wrap text-mist leading-6">{entry.summary}</p>
                        ) : null}
                        {entry.carryForward ? (
                          <p className="mt-2 font-bold text-gold-soft">
                            Carry forward: {entry.carryForward}
                          </p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BottomNav({ onScreen, screen }: { onScreen: (screen: Screen) => void; screen: Screen }) {
  const items: Array<{ screen: Screen; label: string; icon: ReactNode }> = [
    { screen: "capture", label: "Scatter", icon: <Sparkles size={19} /> },
    { screen: "focus", label: "Flow", icon: <CheckCircle2 size={19} /> },
    { screen: "reflect", label: "Reflect", icon: <Moon size={19} /> },
  ];

  return (
    <nav className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] left-4 z-30 mx-auto grid max-w-[430px] grid-cols-3 rounded-full border border-white/10 bg-night/90 p-2 shadow-2xl backdrop-blur-xl md:hidden">
      {items.map((item) => (
        <button
          className={`flex flex-col items-center gap-1 rounded-full px-3 py-2 text-xs ${
            screen === item.screen
              ? "bg-indigo-soft/20 text-indigo-soft"
              : "text-dim hover:text-starlight"
          }`}
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

function DesktopModeSwitcher({
  memoryCount,
  onScreen,
  screen,
}: {
  memoryCount: number;
  onScreen: (screen: Screen) => void;
  screen: Screen;
}) {
  const items: Array<{
    screen: Screen;
    label: string;
    icon: ReactNode;
    badge?: string;
  }> = [
    {
      screen: "capture",
      label: "Scatter",
      icon: <Sparkles size={16} />,
      ...(memoryCount > 0 ? { badge: String(memoryCount) } : {}),
    },
    {
      screen: "focus",
      label: "Flow",
      icon: <CheckCircle2 size={16} />,
    },
    {
      screen: "reflect",
      label: "Reflect",
      icon: <Moon size={16} />,
    },
  ];

  return (
    <nav
      className="mx-auto mb-5 hidden w-fit max-w-full items-center rounded-full border border-white/10 bg-night/80 p-1 shadow-xl backdrop-blur-xl md:flex"
      aria-label="Starflow modes"
    >
      {items.map((item) => {
        const active = screen === item.screen;
        return (
          <button
            type="button"
            key={item.screen}
            className={`inline-flex h-10 items-center gap-2 rounded-full px-4 font-bold text-sm transition ${
              active
                ? "bg-indigo-soft text-indigo-deep shadow-[0_0_18px_rgba(190,194,255,0.18)]"
                : "text-dim hover:bg-white/5 hover:text-starlight"
            }`}
            aria-pressed={active}
            onClick={() => onScreen(item.screen)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge ? (
              <span
                className={`grid min-w-5 place-items-center rounded-full px-1.5 text-[0.65rem] ${
                  active ? "bg-indigo-deep/20 text-indigo-deep" : "bg-white/10 text-dim"
                }`}
              >
                {item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
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
  onApplyCarryForward,
  onMessages,
  onOpenChange,
  onRoute,
  task,
  user,
}: {
  agent: ChatAgent;
  chatOpen: boolean;
  dumpText: string;
  messages: ChatMessage[];
  onApplyCaptureText: (text: string) => void;
  onApplyCarryForward: (text: string) => void;
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
        uiPatch?: { captureText?: string; carryForward?: string; route?: string };
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

      if (data.uiPatch?.carryForward) {
        onApplyCarryForward(data.uiPatch.carryForward);
      }

      if (data.uiPatch?.route) {
        onRoute(data.uiPatch.route);
      }

      if (data.task) {
        queryClient.setQueryData<AppState | undefined>(["state"], (current) => ({
          reflection: current?.reflection ?? { count: 0, latest: null },
          memory: current?.memory ?? { count: 0, latest: null },
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
        className={`button-glow fixed right-5 z-40 grid size-14 place-items-center rounded-full bg-gold-soft text-black shadow-2xl ${user ? "bottom-28 md:bottom-5" : "bottom-5"}`}
        onClick={() => onOpenChange(!chatOpen)}
        aria-label="Open Starflow agent"
      >
        <MessageCircle size={23} />
      </button>
      {chatOpen ? (
        <aside
          className={`fixed right-5 z-40 flex max-h-[70vh] w-[min(420px,calc(100vw-40px))] flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-night/95 shadow-2xl backdrop-blur-xl ${user ? "bottom-44 md:bottom-24" : "bottom-24"}`}
        >
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
