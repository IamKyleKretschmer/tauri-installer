import { useEffect, useRef, useState } from "react";
import type { ActionResult, Blueprint } from "../services/installer.service";
import { saveBlueprint } from "../services/installer.service";

export function BlueprintSavedStep({ path, blueprint }: { path: string; blueprint: Blueprint }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    saveBlueprint(path, blueprint).then(setResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="finished-step">
      <div className={`finished-step__badge ${result && !result.success ? "finished-step__badge--error" : ""}`}>
        {result ? (result.success ? "✓" : "✗") : "…"}
      </div>
      <h1 className="finished-step__title">
        {!result ? "Saving blueprint..." : result.success ? "Blueprint saved" : "Could not save blueprint"}
      </h1>
      <p className="finished-step__subtitle">
        {!result
          ? `Writing your answers to ${path} instead of installing.`
          : result.success
            ? `Run this installer with /install:"${result.message}" on the target machine to install silently from these answers, with no wizard.`
            : result.message}
      </p>
    </div>
  );
}
