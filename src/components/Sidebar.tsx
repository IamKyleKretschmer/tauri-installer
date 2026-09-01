import type { ReactNode } from "react";
import type { WizardStep } from "../App";
import "./Sidebar.css";

interface StepDef {
  id: WizardStep;
  label: string;
  icon: ReactNode;
}

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const CheckCircleIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.5 2.5L16 9.5" />
  </svg>
);

const HomeIcon = (
  <svg {...iconProps}>
    <path d="M3 11l9-8 9 8" />
    <path d="M5 10v10h14V10" />
    <path d="M9 20v-6h6v6" />
  </svg>
);

const ListIcon = (
  <svg {...iconProps}>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
  </svg>
);

const EditIcon = (
  <svg {...iconProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const DatabaseIcon = (
  <svg {...iconProps}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
);

const GridIcon = (
  <svg {...iconProps}>
    <rect x="3" y="3" width="8" height="8" rx="1" />
    <rect x="13" y="3" width="8" height="8" rx="1" />
    <rect x="3" y="13" width="8" height="8" rx="1" />
    <rect x="13" y="13" width="8" height="8" rx="1" />
  </svg>
);

const NetworkIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="4" r="2" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="19" r="2" />
    <path d="M12 6v6M12 12l-6.2 5.5M12 12l6.2 5.5" />
  </svg>
);

const GlobeIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" />
  </svg>
);

const RefreshIcon = (
  <svg {...iconProps}>
    <path d="M4 4v5h5" />
    <path d="M20 20v-5h-5" />
    <path d="M20 9a8 8 0 0 0-14.6-3.6L4 9" />
    <path d="M4 15a8 8 0 0 0 14.6 3.6L20 15" />
  </svg>
);

const STEPS: StepDef[] = [
  { id: "welcome", label: "Welcome", icon: HomeIcon },
  { id: "system-check", label: "System check", icon: ListIcon },
  { id: "prerequisites", label: "Prerequisites", icon: EditIcon },
  { id: "sql-server", label: "SQL Server", icon: DatabaseIcon },
  { id: "iis-net", label: "IIS & .NET", icon: GridIcon },
  { id: "active-directory", label: "Active Directory", icon: NetworkIcon },
  { id: "network-tls", label: "Network & TLS", icon: GlobeIcon },
  { id: "review", label: "Review", icon: ListIcon },
  { id: "install", label: "Install", icon: RefreshIcon },
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
      <div className="sidebar__brand">
        n<span className="sidebar__brand-idot">ı</span>ntex
      </div>
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
                <span className="sidebar__icon">{isDone && !isActive ? CheckCircleIcon : step.icon}</span>
                <span>{step.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
