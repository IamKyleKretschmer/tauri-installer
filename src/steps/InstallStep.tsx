import { useEffect, useRef, useState } from "react";
import { ProgressBar } from "../components/primitives";

const TASKS = [
  "Provisioning K2 database",
  "Registering IIS application pool",
  "Deploying K2 Server components",
  "Configuring service accounts",
  "Applying TLS configuration",
  "Finalizing installation",
];

export function InstallStep({ onDone }: { onDone: () => void }) {
  const [taskIndex, setTaskIndex] = useState(0);
  const [percent, setPercent] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    async function run() {
      for (let i = 0; i < TASKS.length; i++) {
        if (cancelled) return;
        setTaskIndex(i);
        for (let p = 0; p <= 100; p += 25) {
          if (cancelled) return;
          setPercent(Math.round(((i + p / 100) / TASKS.length) * 100));
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (!cancelled) onDone();
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  return (
    <div>
      <h1 className="step-title step-title--sm">Installing K2</h1>
      <p className="step-intro">{TASKS[taskIndex]}…</p>

      <ProgressBar percent={percent} />
      <p className="step-intro">{percent}% complete</p>
    </div>
  );
}
