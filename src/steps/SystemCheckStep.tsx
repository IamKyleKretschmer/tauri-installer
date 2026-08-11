import { useEffect, useRef, useState } from "react";
import type { SystemCheckItem } from "../services/installer.service";
import { runSystemChecks } from "../services/installer.service";

const STATUS_LABEL: Record<SystemCheckItem["status"], string> = {
  pending: "Waiting…",
  checking: "Checking…",
  pass: "Pass",
  fail: "Fail",
};

export function SystemCheckStep({ onComplete }: { onComplete: (items: SystemCheckItem[]) => void }) {
  const [items, setItems] = useState<SystemCheckItem[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runSystemChecks((update) => {
      setItems(update);
      if (update.every((i) => i.status === "pass" || i.status === "fail")) {
        onComplete(update);
      }
    });
  }, [onComplete]);

  return (
    <div>
      <h1 className="step-title step-title--sm">Checking your system</h1>
      <p className="step-intro">Scanning hardware, OS, and existing software. This takes a few seconds.</p>

      <div className="check-list">
        {items.map((item) => (
          <div className="check-row" key={item.id}>
            <div className="check-row__header">
              <span>{item.label}</span>
              <span className={`check-row__status check-row__status--${item.status}`}>
                {STATUS_LABEL[item.status]}
              </span>
            </div>
            <div className="check-row__track">
              <div
                className={`check-row__fill check-row__fill--${item.status}`}
                style={{ width: item.status === "pending" ? "0%" : item.status === "checking" ? "55%" : "100%" }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
