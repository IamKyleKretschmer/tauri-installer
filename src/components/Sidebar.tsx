import type { WizardStep } from "../App";
import "./Sidebar.css";

interface StepDef {
  id: WizardStep;
  label: string;
  icon: string;
}

const STEPS: StepDef[] = [
  { id: "welcome", label: "Welcome", icon: "⌂" },
  { id: "system-check", label: "System check", icon: "≡" },
  { id: "prerequisites", label: "Prerequisites", icon: "✎" },
  { id: "sql-server", label: "SQL Server", icon: "⛁" },
  { id: "iis-net", label: "IIS & .NET", icon: "⊞" },
  { id: "active-directory", label: "Active Directory", icon: "🖧" },
  { id: "network-tls", label: "Network & TLS", icon: "🌐" },
  { id: "review", label: "Review", icon: "☰" },
  { id: "install", label: "Install", icon: "⟳" },
];

export { STEPS };

export function Sidebar({
  current,
  completed,
  onNavigate,
}: {
  current: WizardStep;
  completed: Set<WizardStep>;
  onNavigate: (step: WizardStep) => void;
}) {
  return (
    <nav className="sidebar">
      <div className="sidebar__brand">nintex</div>
      <div className="sidebar__section-label">K2 SETUP</div>
      <ul className="sidebar__list">
        {STEPS.map((step) => {
          const isActive = step.id === current;
          const isDone = completed.has(step.id);
          return (
            <li key={step.id}>
              <button
                className={`sidebar__item ${isActive ? "sidebar__item--active" : ""}`}
                onClick={() => onNavigate(step.id)}
              >
                <span className="sidebar__icon">{isDone && !isActive ? "✓" : step.icon}</span>
                <span>{step.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
