import { useEffect, useRef, useState } from "react";
import type { SqlServerConfig } from "./SqlServerStep";
import { testSqlConnection } from "../services/installer.service";

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

type TaskState = "waiting" | "active" | "complete" | "failed";

export function InstallStep({ onDone, sqlConfig }: { onDone: () => void; sqlConfig: SqlServerConfig }) {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [failedTaskId, setFailedTaskId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  // onDone is an inline arrow function in App.tsx, so it gets a new
  // identity on every App re-render, including the one this loop's own
  // completion triggers. Reading it through a ref (instead of listing it
  // as an effect dependency) keeps the effect from restarting the whole
  // install loop every time that identity changes.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // sqlConfig only needs to be read once, when the "db" task actually
  // runs; reading it through a ref keeps it out of the effect's
  // dependency array so editing it elsewhere can't restart this loop.
  const sqlConfigRef = useRef(sqlConfig);
  useEffect(() => {
    sqlConfigRef.current = sqlConfig;
  }, [sqlConfig]);

  useEffect(() => {
    let cancelled = false;

    async function runFakeTask(task: InstallTask) {
      for (let pct = 0; pct <= 100; pct += 20) {
        if (cancelled) return;
        setProgress((prev) => ({ ...prev, [task.id]: pct }));
        await new Promise((r) => setTimeout(r, 150));
      }
      setLog((prev) => [...prev, `[${timestamp()}] ${task.label} - complete`]);
    }

    /**
     * Runs the real SQL Server connection + database creation
     * (test_sql_connection -> DotNetRunner's SqlServerCheck), using
     * whatever was entered on the SQL Server step. Unlike the other
     * (still simulated) tasks, this one can genuinely fail, e.g. if SQL
     * Server became unreachable between that step and now, and if it
     * does, the whole install stops here instead of continuing to fake
     * success on top of a real failure.
     */
    async function runDatabaseTask(task: InstallTask) {
      setProgress((prev) => ({ ...prev, [task.id]: 40 }));
      const config = sqlConfigRef.current;
      const result = await testSqlConnection({
        instance: config.instance,
        authMode: config.authMode,
        username: config.username,
        password: config.password,
        database: config.databaseName,
      });
      if (cancelled) return false;

      if (!result.success) {
        setLog((prev) => [...prev, `[${timestamp()}] ${task.label} - FAILED: ${result.message}`]);
        setFailedTaskId(task.id);
        return false;
      }

      setProgress((prev) => ({ ...prev, [task.id]: 100 }));
      setLog((prev) => [...prev, `[${timestamp()}] ${task.label} - ${result.message}`]);
      return true;
    }

    async function run() {
      for (const task of TASKS) {
        if (cancelled) return;

        const ok = task.id === "db" ? await runDatabaseTask(task) : (await runFakeTask(task), true);
        if (!ok) return;
      }
      if (!cancelled) onDoneRef.current();
    }
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stateFor(taskIndex: number): TaskState {
    const task = TASKS[taskIndex];
    if (failedTaskId === task.id) return "failed";
    if (failedTaskId && TASKS.findIndex((t) => t.id === failedTaskId) < taskIndex) return "waiting";

    const pct = progress[task.id] ?? 0;
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
                  {state === "complete"
                    ? "Complete"
                    : state === "failed"
                      ? "Failed"
                      : state === "active"
                        ? `Installing… ${pct}%`
                        : "Waiting…"}
                </span>
              </div>
              <div className="tx-progress">
                <div
                  className={`tx-progress__fill tx-progress__fill--${state === "complete" ? "done" : state === "failed" ? "failed" : "active"}`}
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

      {failedTaskId ? (
        <p className="step-intro">Installation stopped. Click Back to fix the issue above and try again.</p>
      ) : (
        <p className="step-intro">
          Installing {completedCount} of {TASKS.length}…
        </p>
      )}
    </div>
  );
}

function timestamp() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}
