import { useEffect, useRef, useState } from "react";
import type { InstallLogLine, PrerequisiteItem } from "../services/installer.service";
import { getPrerequisites, installPrerequisites } from "../services/installer.service";
import { Badge } from "../components/primitives";

export function PrerequisitesStep({ dotnetPresent }: { dotnetPresent: boolean }) {
  const items = getPrerequisites(dotnetPresent);
  const toInstallCount = items.filter((i) => i.status === "will-install").length;

  return (
    <div>
      <h1 className="step-title step-title--sm">Prerequisites</h1>
      <p className="step-intro">Some required software is missing. We'll install it for you before continuing.</p>

      <div className="callout callout--warn">
        {toInstallCount} items will be installed automatically before K2 setup begins. Review below and click
        Next to proceed.
      </div>

      <div className="prereq-list">
        {items.map((item) => (
          <div className="prereq-row" key={item.id}>
            <div>
              <div className="prereq-row__name">{item.name}</div>
              <div className="prereq-row__desc">{item.description}</div>
            </div>
            <Badge tone={item.status === "present" ? "pass" : "warn"}>
              {item.status === "present" ? "Present" : "Will install"}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PrerequisitesInstallStep({
  dotnetPresent,
  onDone,
}: {
  dotnetPresent: boolean;
  onDone: () => void;
}) {
  const items = getPrerequisites(dotnetPresent).filter((i) => i.status === "will-install");
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [log, setLog] = useState<InstallLogLine[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void installPrerequisites(
      items as PrerequisiteItem[],
      (id, pct) => setProgress((prev) => ({ ...prev, [id]: pct })),
      (line) => setLog((prev) => [...prev, line]),
    ).then(onDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const completedCount = items.filter((i) => (progress[i.id] ?? 0) >= 100).length;

  return (
    <div>
      <h1 className="step-title step-title--sm">Installing prerequisites</h1>
      <p className="step-intro">Please wait. Do not close this window</p>

      <div className="prereq-list">
        {items.map((item) => {
          const pct = progress[item.id] ?? 0;
          return (
            <div className="prereq-progress-row" key={item.id}>
              <div className="prereq-progress-row__header">
                <span>{item.name}</span>
                <span className="prereq-progress-row__status">
                  {pct >= 100 ? "Complete" : pct > 0 ? `Installing… ${pct}%` : ""}
                </span>
              </div>
              <div className="tx-progress">
                <div
                  className={`tx-progress__fill tx-progress__fill--${pct >= 100 ? "done" : "active"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <pre className="install-console">
        {log.map((line, idx) => (
          <div key={idx}>
            [{line.timestamp}] {line.message}
          </div>
        ))}
      </pre>

      <p className="step-intro">
        Installing {completedCount} of {items.length}…
      </p>
    </div>
  );
}
