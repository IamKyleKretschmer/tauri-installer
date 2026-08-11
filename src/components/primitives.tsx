import type { ButtonHTMLAttributes, InputHTMLAttributes } from "react";
import "./primitives.css";

type ButtonVariant = "primary" | "secondary";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

/** Stand-in for Textura's <Button> until @exp-textura/react is installable. */
export function Button({ variant = "primary", className = "", ...rest }: ButtonProps) {
  return <button className={`tx-button tx-button--${variant} ${className}`} {...rest} />;
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

/** Stand-in for Textura's <TextInput> until @exp-textura/react is installable. */
export function TextInput({ label, hint, id, className = "", ...rest }: TextInputProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="tx-field">
      {label && (
        <label className="tx-field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input id={inputId} className={`tx-input ${className}`} {...rest} />
      {hint && <p className="tx-field__hint">{hint}</p>}
    </div>
  );
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
}

export function Select({ label, hint, id, className = "", children, ...rest }: SelectProps) {
  const selectId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="tx-field">
      {label && (
        <label className="tx-field__label" htmlFor={selectId}>
          {label}
        </label>
      )}
      <select id={selectId} className={`tx-input tx-select ${className}`} {...rest}>
        {children}
      </select>
      {hint && <p className="tx-field__hint">{hint}</p>}
    </div>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: "pass" | "caution" | "warn" | "neutral";
  children: React.ReactNode;
}) {
  return <span className={`tx-badge tx-badge--${tone}`}>{children}</span>;
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="tx-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`tx-toggle__track ${checked ? "tx-toggle__track--on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="tx-toggle__thumb" />
      </button>
      <span>{label}</span>
    </label>
  );
}

export function Banner({ tone = "success", children }: { tone?: "success" | "info" | "warn"; children: React.ReactNode }) {
  return <div className={`tx-banner tx-banner--${tone}`}>{children}</div>;
}

export function ProgressBar({ percent, tone = "active" }: { percent: number; tone?: "active" | "done" }) {
  return (
    <div className="tx-progress">
      <div className={`tx-progress__fill tx-progress__fill--${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}
