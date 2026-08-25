import { useEffect, useRef, useState } from "react";
import type { ComponentCategory, K2Component } from "../data/k2Components";
import { COMPONENT_CATEGORIES, K2_COMPONENTS, childrenOf, executionOrder } from "../data/k2Components";

type ComponentStatus = "pending" | "active" | "done";

function ComponentRow({ component, status, depth }: { component: K2Component; status: ComponentStatus; depth: number }) {
  const icon = status === "done" ? "✓" : status === "active" ? "●" : "○";
  return (
    <div
      className={`component-row component-row--${status}`}
      style={{ marginLeft: `${depth * 1.25}rem` }}
    >
      <span className="component-row__icon">{icon}</span>
      <span className="component-row__name">{component.displayName}</span>
    </div>
  );
}

function ComponentTree({ statuses }: { statuses: Record<string, ComponentStatus> }) {
  function renderNode(component: K2Component, depth: number) {
    return (
      <div key={component.id}>
        <ComponentRow component={component} status={statuses[component.id] ?? "pending"} depth={depth} />
        {childrenOf(component.id).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <div className="component-tree">
      {COMPONENT_CATEGORIES.map((category: ComponentCategory) => (
        <div key={category}>
          <div className="component-row component-row--category">{category}</div>
          {K2_COMPONENTS.filter((c) => c.category === category && !c.parentId).map((component) =>
            renderNode(component, 1),
          )}
        </div>
      ))}
    </div>
  );
}

export function InstallStep({ onDone }: { onDone: () => void }) {
  const [statuses, setStatuses] = useState<Record<string, ComponentStatus>>({});
  const [currentTarget, setCurrentTarget] = useState("");
  const [percent, setPercent] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    async function run() {
      const order = executionOrder();
      const totalTargets = order.reduce((sum, c) => sum + c.targets.length, 0);
      let completedTargets = 0;

      for (const component of order) {
        if (cancelled) return;
        setStatuses((prev) => ({ ...prev, [component.id]: "active" }));

        for (const target of component.targets) {
          if (cancelled) return;
          setCurrentTarget(target);
          await new Promise((r) => setTimeout(r, 350));
          completedTargets += 1;
          setPercent(Math.round((completedTargets / totalTargets) * 100));
        }

        setStatuses((prev) => ({ ...prev, [component.id]: "done" }));
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
      <h1 className="step-title step-title--sm">Components</h1>
      <p className="step-intro">Please wait while K2 installs the components below. Do not close this window.</p>

      <ComponentTree statuses={statuses} />

      <div className="component-progress">
        <div className="tx-progress">
          <div className="tx-progress__fill tx-progress__fill--active" style={{ width: `${percent}%` }} />
        </div>
        <p className="component-progress__current">{currentTarget || "Preparing installation..."}</p>
      </div>
    </div>
  );
}
