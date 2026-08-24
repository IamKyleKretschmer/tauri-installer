import { useEffect, useState } from "react";
import { Sidebar, STEPS } from "./components/Sidebar";
import { WizardShell } from "./components/WizardShell";
import { WelcomeStep } from "./steps/WelcomeStep";
import { MaintenanceStep } from "./steps/MaintenanceStep";
import type { MaintenanceAction } from "./steps/MaintenanceStep";
import { Button } from "./components/primitives";
import { SystemCheckStep } from "./steps/SystemCheckStep";
import { PrerequisitesInstallStep, PrerequisitesStep } from "./steps/PrerequisitesStep";
import { SqlServerStep } from "./steps/SqlServerStep";
import type { SqlServerConfig } from "./steps/SqlServerStep";
import { IisNetStep } from "./steps/IisNetStep";
import type { IisNetConfig } from "./steps/IisNetStep";
import { ActiveDirectoryStep } from "./steps/ActiveDirectoryStep";
import type { ActiveDirectoryConfig } from "./steps/ActiveDirectoryStep";
import { NetworkTlsStep } from "./steps/NetworkTlsStep";
import type { NetworkTlsConfig } from "./steps/NetworkTlsStep";
import { ReviewStep } from "./steps/ReviewStep";
import { InstallStep } from "./steps/InstallStep";
import type { PrerequisiteItem, SystemCheckItem } from "./services/installer.service";
import { detectK2Installed } from "./services/installer.service";
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
  username: "sa",
  password: "",
  databaseName: "K2",
};

const DEFAULT_IIS_CONFIG: IisNetConfig = {
  siteName: "K2",
  httpPort: "80",
  httpsPort: "443",
  appPoolIdentity: "NetworkService",
  sslCertificate: "",
};

const DEFAULT_AD_CONFIG: ActiveDirectoryConfig = {
  serviceAccount: "CONTOSO\\svc-k2",
  servicePassword: "",
  adminsGroup: "CONTOSO\\K2Admins",
  createGroupIfMissing: true,
};

const DEFAULT_NETWORK_CONFIG: NetworkTlsConfig = {
  hostname: "k2server.contoso.local",
};

function App() {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [completed, setCompleted] = useState<Set<WizardStep>>(new Set());
  const [systemChecksDone, setSystemChecksDone] = useState(false);
  const [systemCheckItems, setSystemCheckItems] = useState<SystemCheckItem[]>([]);
  const [prerequisiteItems, setPrerequisiteItems] = useState<PrerequisiteItem[] | null>(null);
  const [sqlConfig, setSqlConfig] = useState<SqlServerConfig>(DEFAULT_SQL_CONFIG);
  const [iisConfig, setIisConfig] = useState<IisNetConfig>(DEFAULT_IIS_CONFIG);
  const [adConfig, setAdConfig] = useState<ActiveDirectoryConfig>(DEFAULT_AD_CONFIG);
  const [networkConfig, setNetworkConfig] = useState<NetworkTlsConfig>(DEFAULT_NETWORK_CONFIG);

  const [k2Installed, setK2Installed] = useState<boolean | null>(null);
  const [maintenanceAction, setMaintenanceAction] = useState<MaintenanceAction>("configure");
  const [maintenanceChosen, setMaintenanceChosen] = useState<MaintenanceAction | null>(null);

  useEffect(() => {
    detectK2Installed().then(setK2Installed);
  }, []);

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
            setSystemCheckItems(items);
          }}
        />
      );
      nextDisabled = !systemChecksDone;
      break;
    case "prerequisites": {
      const toInstallCount = prerequisiteItems?.filter((i) => i.status === "will-install").length ?? 0;
      const hasBlocker = prerequisiteItems?.some((i) => i.status === "blocked") ?? false;
      body = <PrerequisitesStep systemChecks={systemCheckItems} onLoaded={setPrerequisiteItems} />;
      nextLabel = prerequisiteItems
        ? toInstallCount > 0
          ? `Next - install ${toInstallCount} item${toInstallCount === 1 ? "" : "s"}`
          : "Next"
        : "Checking...";
      // A blocked item (e.g. missing .NET Framework) cannot be
      // auto-installed, matching the legacy installer's hard stop.
      nextDisabled = !prerequisiteItems || hasBlocker;
      break;
    }
    case "prerequisites-install":
      body = <PrerequisitesInstallStep items={prerequisiteItems ?? []} onDone={() => goTo("sql-server")} />;
      nextDisabled = true;
      break;
    case "sql-server":
      body = <SqlServerStep config={sqlConfig} onChange={setSqlConfig} />;
      nextLabel = "Test connection & Next";
      break;
    case "iis-net":
      body = <IisNetStep config={iisConfig} onChange={setIisConfig} />;
      break;
    case "active-directory":
      body = <ActiveDirectoryStep config={adConfig} onChange={setAdConfig} />;
      nextLabel = "Validate & Next";
      break;
    case "network-tls":
      body = <NetworkTlsStep config={networkConfig} onChange={setNetworkConfig} />;
      break;
    case "review":
      body = (
        <ReviewStep sqlConfig={sqlConfig} iisConfig={iisConfig} adConfig={adConfig} networkConfig={networkConfig} />
      );
      nextLabel = "Install K2";
      break;
    case "install":
      body = <InstallStep onDone={() => setCompleted((prev) => new Set(prev).add("install"))} />;
      nextDisabled = !completed.has("install");
      nextLabel = "Finish";
      break;
  }

  if (k2Installed && maintenanceChosen === null) {
    return (
      <div className="app-shell">
        <MaintenanceStep
          selected={maintenanceAction}
          onSelect={setMaintenanceAction}
          onContinue={() => setMaintenanceChosen(maintenanceAction)}
        />
      </div>
    );
  }

  if (maintenanceChosen && maintenanceChosen !== "configure") {
    return (
      <div className="app-shell">
        <div className="maintenance-gate">
          <div className="maintenance-card">
            <h2 className="maintenance-card__title">{capitalize(maintenanceChosen)}</h2>
            <p className="maintenance-card__intro">
              {capitalize(maintenanceChosen)} is not implemented in this spike. Sprint 1 only covers a fresh
              install (the Configure path).
            </p>
            <div className="maintenance-card__actions">
              <Button variant="secondary" onClick={() => setMaintenanceChosen(null)}>
                Back
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default App;
