import { useEffect, useRef, useState } from "react";

interface InstallTask {
  id: string;
  label: string;
  subLabel: string;
}

const TASKS: InstallTask[] = [
  { id: "db", label: "Creating K2 database", subLabel: "Applying collation and schema" },
  { id: "iis", label: "Configuring IIS site & app pool", subLabel: "Binding ports 80/443" },
  { id: "tls", label: "Disabling TLS 1.0 / 1.1", subLabel: "Updating Schannel registry keys" },
  { id: "components", label: "Installing K2 Server components", subLabel: "Registering K2 Windows services" },
  { id: "ad", label: "Configuring AD service account", subLabel: "Granting local service rights" },
  { id: "start", label: "Starting K2 services", subLabel: "Waiting for services to report healthy" },
];

type TaskState = "waiting" | "active" | "complete";

export function InstallStep({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [log, setLog] = useState<string[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    async function run() {
      for (const task of TASKS) {
        if (cancelled) return;
        for (let pct = 0; pct <= 100; pct += 20) {
          if (cancelled) return;
          setProgress((prev) => ({ ...prev, [task.id]: pct }));
          await new Promise((r) => setTimeout(r, 150));
        }
        setLog((prev) => [...prev, `[${timestamp()}] ${task.label} - complete`]);
      }
      if (!cancelled) onDone();
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  function stateFor(taskIndex: number): TaskState {
    const pct = progress[TASKS[taskIndex].id] ?? 0;
    if (pct >= 100) return "complete";
    if (taskIndex === 0 || (progress[TASKS[taskIndex - 1].id] ?? 0) >= 100) {
      return pct > 0 || taskIndex === TASKS.findIndex((t) => (progress[t.id] ?? 0) < 100) ? "active" : "waiting";
    }
    return "waiting";
  }

  const completedCount = TASKS.filter((t) => (progress[t.id] ?? 0) >= 100).length;

  return (
    <div>
      <h1 className="step-title step-title--sm">Installing K2</h1>
      <p className="step-intro">This may take several minutes. Please do not close this window or restart the machine.</p>

      <div className="prereq-list">
        {TASKS.map((task, idx) => {
          const pct = progress[task.id] ?? 0;
          const state = stateFor(idx);
          return (
            <div className="prereq-progress-row" key={task.id}>
              <div className="prereq-progress-row__header">
                <span>{task.label}</span>
                <span className={`prereq-progress-row__status prereq-progress-row__status--${state}`}>
                  {state === "complete" ? "Complete" : state === "active" ? `Installing… ${pct}%` : "Waiting…"}
                </span>
              </div>
              <div className="tx-progress">
                <div
                  className={`tx-progress__fill tx-progress__fill--${state === "complete" ? "done" : "active"}`}
                  style={{ width: `${state === "waiting" ? 0 : pct}%` }}
                />
              </div>
              {state === "active" && <p className="prereq-progress-row__sublabel">{task.subLabel}</p>}
            </div>
          );
        })}
      </div>

      <pre className="install-console">
        {log.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </pre>

      <p className="step-intro">
        Installing {completedCount} of {TASKS.length}…
      </p>
    </div>
  );
}

function timestamp() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}
