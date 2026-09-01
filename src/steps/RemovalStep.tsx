import { useEffect, useRef, useState } from "react";
import type { RemoveConfig } from "./RemoveStep";
import { dropK2Database, removeIisSite, restoreLegacyTls, revokeServiceLogonRight } from "../services/installer.service";

interface RemovalTask {
  id: string;
  label: string;
}

const TASKS: RemovalTask[] = [
  { id: "iis", label: "Removing IIS site & app pools" },
  { id: "db", label: "Dropping K2 database" },
  { id: "tls", label: "Re-enabling TLS 1.0 / 1.1" },
  { id: "ad", label: "Revoking AD service logon right" },
];

export interface RemovalSummary {
  log: string[];
  failed: boolean;
}

export function RemovalStep({ config, onDone }: { config: RemoveConfig; onDone: (summary: RemovalSummary) => void }) {
  const [progress, setProgress] = useState<Record<string, "waiting" | "active" | "complete" | "failed">>({});
  const [log, setLog] = useState<string[]>([]);
  const configRef = useRef(config);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    configRef.current = config;
    onDoneRef.current = onDone;
  }, [config, onDone]);

  useEffect(() => {
    let cancelled = false;
    const logLines: string[] = [];

    function appendLog(message: string) {
      const line = `[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ${message}`;
      logLines.push(line);
      setLog((prev) => [...prev, line]);
    }

    async function run() {
      const cfg = configRef.current;
      const actions: Record<string, () => Promise<{ success: boolean; message: string }>> = {
        iis: () => removeIisSite(cfg.siteName),
        db: () =>
          dropK2Database({
            instance: cfg.sqlInstance,
            authMode: cfg.sqlAuthMode,
            username: cfg.sqlUsername,
            password: cfg.sqlPassword,
            database: cfg.databaseName,
          }),
        tls: () => restoreLegacyTls(),
        ad: () => revokeServiceLogonRight(cfg.adServiceAccount),
      };

      let anyFailed = false;
      for (const task of TASKS) {
        if (cancelled) return;
        setProgress((prev) => ({ ...prev, [task.id]: "active" }));
        const result = await actions[task.id]();
        if (cancelled) return;

        if (!result.success) {
          appendLog(`${task.label} - FAILED: ${result.message}`);
          setProgress((prev) => ({ ...prev, [task.id]: "failed" }));
          anyFailed = true;
          continue;
        }
        appendLog(`${task.label} - ${result.message}`);
        setProgress((prev) => ({ ...prev, [task.id]: "complete" }));
      }

      if (cancelled) return;
      onDoneRef.current({ log: logLines, failed: anyFailed });
    }
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h1 className="step-title step-title--sm">Removing K2</h1>
      <p className="step-intro">This may take a minute. Please do not close this window.</p>

      <div className="prereq-list">
        {TASKS.map((task) => {
          const state = progress[task.id] ?? "waiting";
          return (
            <div className="prereq-progress-row" key={task.id}>
              <div className="prereq-progress-row__header">
                <span>{task.label}</span>
                <span className={`prereq-progress-row__status prereq-progress-row__status--${state === "complete" ? "complete" : state === "failed" ? "failed" : "waiting"}`}>
                  {state === "complete" ? "Complete" : state === "failed" ? "Failed" : state === "active" ? "Working..." : "Waiting..."}
                </span>
              </div>
              <div className="tx-progress">
                <div
                  className={`tx-progress__fill tx-progress__fill--${state === "complete" ? "done" : state === "failed" ? "failed" : "active"}`}
                  style={{ width: state === "waiting" ? "0%" : state === "active" ? "50%" : "100%" }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <pre className="install-console">
        {log.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </pre>
    </div>
  );
}
