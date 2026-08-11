import type { ReactNode } from "react";
import { Button } from "./primitives";
import "./WizardShell.css";

export function WizardShell({
  stepIndex,
  stepCount,
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
  nextLabel = "Next",
  children,
}: {
  stepIndex: number;
  stepCount: number;
  onBack: () => void;
  onNext: () => void;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  nextLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="wizard-shell">
      <div className="wizard-shell__content">{children}</div>
      <footer className="wizard-shell__footer">
        <span className="wizard-shell__step">
          Step {stepIndex} of {stepCount}
        </span>
        <div className="wizard-shell__actions">
          <Button variant="secondary" onClick={onBack} disabled={backDisabled}>
            Back
          </Button>
          <Button variant="primary" onClick={onNext} disabled={nextDisabled}>
            {nextLabel}
          </Button>
        </div>
      </footer>
    </div>
  );
}
