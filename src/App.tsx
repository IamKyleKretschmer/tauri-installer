import { useState } from "react";
import { Sidebar, STEPS } from "./components/Sidebar";
import { WizardShell } from "./components/WizardShell";
import { WelcomeStep } from "./steps/WelcomeStep";
import { SystemCheckStep } from "./steps/SystemCheckStep";
import { PrerequisitesInstallStep, PrerequisitesStep } from "./steps/PrerequisitesStep";
import { SqlServerStep } from "./steps/SqlServerStep";
import type { SqlServerConfig } from "./steps/SqlServerStep";
import { IisNetStep } from "./steps/IisNetStep";
import { ActiveDirectoryStep } from "./steps/ActiveDirectoryStep";
import { NetworkTlsStep } from "./steps/NetworkTlsStep";
import { ReviewStep } from "./steps/ReviewStep";
import { InstallStep } from "./steps/InstallStep";
import type { SystemCheckItem } from "./services/installer.service";
import "./App.css";

export type WizardStep =
  | "welcome"
  | "system-check"
  | "prerequisites"
  | "prerequisites-install"
  | "sql-server"
  | "iis-net"
  | "active-directory"
  | "network-tls"
  | "review"
  | "install";

const ORDER: WizardStep[] = [
  "welcome",
  "system-check",
  "prerequisites",
  "prerequisites-install",
  "sql-server",
  "iis-net",
  "active-directory",
  "network-tls",
  "review",
  "install",
];

const DEFAULT_SQL_CONFIG: SqlServerConfig = {
  instanceSource: "existing",
  instance: "",
  authMode: "sql",
  username: "",
  password: "",
  databaseName: "K2",
};

function App() {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [completed, setCompleted] = useState<Set<WizardStep>>(new Set());
  const [systemChecksDone, setSystemChecksDone] = useState(false);
  const [dotnetPresent, setDotnetPresent] = useState(false);
  const [sqlConfig, setSqlConfig] = useState<SqlServerConfig>(DEFAULT_SQL_CONFIG);

  const index = ORDER.indexOf(step);

  function goTo(next: WizardStep) {
    setCompleted((prev) => new Set(prev).add(step));
    setStep(next);
  }

  function handleBack() {
    if (index === 0) return;
    setStep(ORDER[index - 1]);
  }

  function handleNext() {
    if (index >= ORDER.length - 1) return;
    goTo(ORDER[index + 1]);
  }

  function sidebarStepId(s: WizardStep) {
    return s === "prerequisites-install" ? "prerequisites" : s;
  }

  let body: React.ReactNode;
  let nextDisabled = false;
  let nextLabel = "Next";

  switch (step) {
    case "welcome":
      body = <WelcomeStep />;
      break;
    case "system-check":
      body = (
        <SystemCheckStep
          onComplete={(items: SystemCheckItem[]) => {
            setSystemChecksDone(true);
            setDotnetPresent(items.find((i) => i.id === "dotnet")?.status === "pass");
          }}
        />
      );
      nextDisabled = !systemChecksDone;
      break;
    case "prerequisites":
      body = <PrerequisitesStep dotnetPresent={dotnetPresent} />;
      nextLabel = "Next – install 3 items";
      break;
    case "prerequisites-install":
      body = <PrerequisitesInstallStep dotnetPresent={dotnetPresent} onDone={() => goTo("sql-server")} />;
      nextDisabled = true;
      break;
    case "sql-server":
      body = <SqlServerStep config={sqlConfig} onChange={setSqlConfig} />;
      nextLabel = "Test connection & Next";
      break;
    case "iis-net":
      body = <IisNetStep />;
      break;
    case "active-directory":
      body = <ActiveDirectoryStep />;
      break;
    case "network-tls":
      body = <NetworkTlsStep />;
      break;
    case "review":
      body = <ReviewStep sqlConfig={sqlConfig} />;
      nextLabel = "Install";
      break;
    case "install":
      body = <InstallStep onDone={() => setCompleted((prev) => new Set(prev).add("install"))} />;
      nextDisabled = !completed.has("install");
      nextLabel = "Finish";
      break;
  }

  return (
    <div className="app-shell">
      <Sidebar
        current={sidebarStepId(step) as WizardStep}
        completed={completed}
        onNavigate={(s) => setStep(s)}
      />
      <WizardShell
        stepIndex={STEPS.findIndex((s) => s.id === sidebarStepId(step)) + 1}
        stepCount={STEPS.length}
        onBack={handleBack}
        onNext={handleNext}
        backDisabled={index === 0}
        nextDisabled={nextDisabled}
        nextLabel={nextLabel}
      >
        {body}
      </WizardShell>
    </div>
  );
}

export default App;
