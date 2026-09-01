import { useEffect, useState } from "react";
import { Sidebar, STEPS } from "./components/Sidebar";
import { WizardShell } from "./components/WizardShell";
import { WelcomeStep, AVAILABLE_VERSIONS } from "./steps/WelcomeStep";
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
import { FinishedStep, formatElapsed } from "./steps/FinishedStep";
import type { FinishedSummary } from "./steps/FinishedStep";
import { BlueprintSavedStep } from "./steps/BlueprintSavedStep";
import { RemoveStep } from "./steps/RemoveStep";
import type { RemoveConfig } from "./steps/RemoveStep";
import { RemovalStep } from "./steps/RemovalStep";
import type { RemovalSummary } from "./steps/RemovalStep";
import type {
  ActionResult,
  CertificateInfo,
  CheckResult,
  IisChecks,
  LoadState,
  NetworkChecks,
  PrerequisiteItem,
  ProductInfo,
  SystemCheckItem,
} from "./services/installer.service";
import {
  checkPort,
  closeAppWindow,
  getInstalledK2Version,
  getLaunchArgs,
  getProductInfo,
  getReviewChecklist,
  loadBlueprint,
  openExternalUrl,
  testSqlConnection,
  validateActiveDirectory,
} from "./services/installer.service";
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
  sourceFilesPath: "",
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

const DEFAULT_REMOVE_CONFIG: RemoveConfig = {
  siteName: DEFAULT_IIS_CONFIG.siteName,
  sqlInstance: "",
  sqlAuthMode: DEFAULT_SQL_CONFIG.authMode,
  sqlUsername: DEFAULT_SQL_CONFIG.username,
  sqlPassword: "",
  databaseName: DEFAULT_SQL_CONFIG.databaseName,
  adServiceAccount: DEFAULT_AD_CONFIG.serviceAccount,
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

  const [maintenanceAction, setMaintenanceAction] = useState<MaintenanceAction>("configure");
  const [maintenanceChosen, setMaintenanceChosen] = useState<MaintenanceAction | null>(null);
  const [removeConfig, setRemoveConfig] = useState<RemoveConfig>(DEFAULT_REMOVE_CONFIG);
  const [removeConfirmed, setRemoveConfirmed] = useState(false);
  const [removalSummary, setRemovalSummary] = useState<RemovalSummary | null>(null);

  const [sqlTesting, setSqlTesting] = useState(false);
  const [sqlTestResult, setSqlTestResult] = useState<ActionResult | null>(null);

  const [iisChecks, setIisChecks] = useState<IisChecks | null>(null);
  const [iisTesting, setIisTesting] = useState(false);
  const [portTestResult, setPortTestResult] = useState<ActionResult | null>(null);

  const [adDomain, setAdDomain] = useState<CheckResult | null>(null);
  const [adTesting, setAdTesting] = useState(false);
  const [adValidationResult, setAdValidationResult] = useState<ActionResult | null>(null);

  const [networkChecks, setNetworkChecks] = useState<NetworkChecks | null>(null);

  const [installSummary, setInstallSummary] = useState<FinishedSummary | null>(null);

  // Fetched once here (rather than separately in Welcome/Maintenance) so
  // the one-time registry scan for the installed version only runs once.
  const [product, setProduct] = useState<LoadState<ProductInfo>>({ status: "loading" });
  const [installedVersion, setInstalledVersion] = useState<LoadState<string | null>>({ status: "loading" });
  const [selectedVersion, setSelectedVersion] = useState(AVAILABLE_VERSIONS[0]);
  // Downstream steps (install log, finished summary) should reflect the
  // version chosen on the Welcome step, not just the build's baked-in one.
  const effectiveProduct: ProductInfo | null =
    product.status === "ready"
      ? { ...product.value, version: selectedVersion, fullVersion: `${product.value.name} ${selectedVersion}` }
      : null;

  // Mirrors the legacy installer's /output:bp.xml and /install:bp.xml
  // command-line switches: write an answer file instead of installing,
  // or install from one with no interactive wizard at all.
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [silentInstall, setSilentInstall] = useState<
    { status: "checking" } | { status: "none" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready" }
  >({ status: "checking" });

  useEffect(() => {
    getProductInfo()
      .then((value) => setProduct({ status: "ready", value }))
      .catch(() => setProduct({ status: "error" }));

    getInstalledK2Version()
      .then((value) => setInstalledVersion({ status: "ready", value }))
      .catch(() => setInstalledVersion({ status: "error" }));

    getLaunchArgs().then((args) => {
      setOutputPath(args.output);
      if (!args.install) {
        setSilentInstall({ status: "none" });
        return;
      }
      setSilentInstall({ status: "loading" });
      loadBlueprint(args.install).then((result) => {
        if (!result.success || !result.blueprint) {
          setSilentInstall({ status: "error", message: result.message });
          return;
        }
        setSqlConfig(result.blueprint.sqlConfig);
        setIisConfig(result.blueprint.iisConfig);
        setAdConfig(result.blueprint.adConfig);
        setNetworkConfig(result.blueprint.networkConfig);
        setSilentInstall({ status: "ready" });
      });
    });
  }, []);

  const k2Installed = installedVersion.status === "ready" && installedVersion.value !== null;

  const index = ORDER.indexOf(step);

  function goTo(next: WizardStep) {
    setCompleted((prev) => new Set(prev).add(step));
    setStep(next);
  }

  function handleBack() {
    if (index === 0) return;
    setStep(ORDER[index - 1]);
  }

  async function handleNext() {
    if (index >= ORDER.length - 1) return;

    if (step === "sql-server") {
      setSqlTesting(true);
      setSqlTestResult(null);
      const result = await testSqlConnection({
        instance: sqlConfig.instance,
        authMode: sqlConfig.authMode,
        username: sqlConfig.username,
        password: sqlConfig.password,
        database: sqlConfig.databaseName,
      });
      setSqlTesting(false);
      setSqlTestResult(result);
      if (!result.success) return;
    }

    if (step === "iis-net") {
      // Informational only, doesn't block Next: a port already in use by
      // IIS's own Default Web Site isn't a real conflict (http.sys shares
      // ports across sites via host headers), and the real K2 installer
      // doesn't require changing ports for this either. Still worth
      // surfacing when it genuinely is a different process holding the
      // port, so the user has a heads-up before Install fails on it.
      setIisTesting(true);
      setPortTestResult(null);
      const httpPort = Number(iisConfig.httpPort);
      const httpsPort = Number(iisConfig.httpsPort);
      const [httpResult, httpsResult] = await Promise.all([checkPort(httpPort), checkPort(httpsPort)]);
      setIisTesting(false);
      const conflict = !httpResult.pass ? httpResult : !httpsResult.pass ? httpsResult : null;
      setPortTestResult(conflict ? { success: false, message: conflict.detail } : { success: true, message: "Ports are available." });
    }

    if (step === "active-directory") {
      // Informational only, doesn't block Next: PrincipalContext needs a
      // classic AD domain context, which an Entra/Azure AD-joined-only
      // machine (no on-prem AD) won't have even though it's a perfectly
      // valid K2 environment, so a lookup failure here isn't necessarily
      // a real problem with the entered values.
      setAdTesting(true);
      setAdValidationResult(null);
      const result = await validateActiveDirectory({
        serviceAccount: adConfig.serviceAccount,
        adminsGroup: adConfig.adminsGroup,
        createGroupIfMissing: adConfig.createGroupIfMissing,
      });
      setAdTesting(false);
      setAdValidationResult(result);
    }

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
      body = (
        <WelcomeStep
          product={product}
          installedVersion={installedVersion}
          selectedVersion={selectedVersion}
          onVersionChange={setSelectedVersion}
        />
      );
      // Keep Next disabled until both the target version/install type and
      // the currently-installed check have resolved (success or failure).
      nextDisabled = product.status === "loading" || installedVersion.status === "loading";
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
      body = (
        <SqlServerStep
          config={sqlConfig}
          onChange={(next) => {
            setSqlConfig(next);
            setSqlTestResult(null);
          }}
          testResult={sqlTestResult}
        />
      );
      nextLabel = sqlTesting ? "Testing connection..." : "Test connection & Next";
      nextDisabled = sqlTesting;
      break;
    case "iis-net":
      body = (
        <IisNetStep
          config={iisConfig}
          onChange={(next) => {
            setIisConfig(next);
            setPortTestResult(null);
          }}
          onLoaded={setIisChecks}
          portTestResult={portTestResult}
        />
      );
      nextLabel = iisTesting ? "Checking ports..." : "Next";
      nextDisabled = !iisChecks || iisTesting;
      break;
    case "active-directory":
      body = (
        <ActiveDirectoryStep
          config={adConfig}
          onChange={(next) => {
            setAdConfig(next);
            setAdValidationResult(null);
          }}
          onLoaded={setAdDomain}
          validationResult={adValidationResult}
        />
      );
      nextLabel = adTesting ? "Validating..." : "Validate & Next";
      nextDisabled = !adDomain || adTesting;
      break;
    case "network-tls":
      body = <NetworkTlsStep config={networkConfig} onChange={setNetworkConfig} onLoaded={setNetworkChecks} />;
      nextDisabled = !networkChecks;
      break;
    case "review": {
      body = (
        <ReviewStep
          sqlConfig={sqlConfig}
          iisConfig={iisConfig}
          adConfig={adConfig}
          networkConfig={networkConfig}
          domain={adDomain}
          networkChecks={networkChecks}
          certificates={iisChecks?.certificates ?? ([] as CertificateInfo[])}
          sqlTestResult={sqlTestResult}
          portTestResult={portTestResult}
        />
      );
      const checklist = getReviewChecklist({
        sqlTestResult,
        siteName: iisConfig.siteName,
        portTestResult,
        serviceAccount: adConfig.serviceAccount,
        adminsGroup: adConfig.adminsGroup,
        hostname: networkConfig.hostname,
      });
      // Only once every required item has a tick can the customer install,
      // a wrong or missing value here could otherwise fail partway
      // through the real install.
      nextDisabled = !checklist.every((item) => item.pass);
      nextLabel = "Install K2";
      break;
    }
    case "install":
      if (outputPath) {
        // /output mode: write the answer file instead of installing.
        body = <BlueprintSavedStep path={outputPath} blueprint={{ sqlConfig, iisConfig, adConfig, networkConfig }} />;
      } else if (installSummary) {
        body = <FinishedStep summary={installSummary} />;
      } else {
        body = (
          <InstallStep
            sqlConfig={sqlConfig}
            iisConfig={iisConfig}
            adServiceAccount={adConfig.serviceAccount}
            product={effectiveProduct}
            prerequisiteItems={prerequisiteItems}
            hostname={networkConfig.hostname}
            stepCount={STEPS.length}
            onDone={(summary) => {
              setCompleted((prev) => new Set(prev).add("install"));
              setInstallSummary(summary);
            }}
          />
        );
      }
      nextDisabled = !completed.has("install");
      nextLabel = "Finish";
      break;
  }

  const finishedFooter =
    step === "install" && outputPath ? (
      <div className="wizard-shell__actions" style={{ marginLeft: "auto" }}>
        <Button variant="primary" onClick={() => void closeAppWindow()}>
          Close
        </Button>
      </div>
    ) : step === "install" && installSummary ? (
      <>
        <span className="wizard-shell__step">
          Setup complete - {installSummary.stepCount} steps in {formatElapsed(installSummary.elapsedMs)}
        </span>
        <div className="wizard-shell__actions">
          <Button variant="secondary" onClick={() => void closeAppWindow()}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => void openExternalUrl(`https://${installSummary.hostname}/Management`)}
          >
            Open K2 Management
          </Button>
        </div>
      </>
    ) : undefined;

  // /install:bp.xml mode: no wizard, no Maintenance gate, just run the
  // install from the loaded answer file and show progress.
  if (silentInstall.status === "loading" || silentInstall.status === "error" || silentInstall.status === "ready") {
    return (
      <div className="app-shell">
        <div className="wizard-shell">
          <div className="wizard-shell__content">
            {silentInstall.status === "loading" ? (
              <p className="step-intro">Loading blueprint...</p>
            ) : silentInstall.status === "error" ? (
              <div className="finished-step">
                <div className="finished-step__badge finished-step__badge--error">✗</div>
                <h1 className="finished-step__title">Could not start silent install</h1>
                <p className="finished-step__subtitle">{silentInstall.message}</p>
              </div>
            ) : installSummary ? (
              <FinishedStep summary={installSummary} />
            ) : (
              <InstallStep
                sqlConfig={sqlConfig}
                iisConfig={iisConfig}
                adServiceAccount={adConfig.serviceAccount}
                product={effectiveProduct}
                prerequisiteItems={null}
                hostname={networkConfig.hostname}
                stepCount={STEPS.length}
                onDone={setInstallSummary}
              />
            )}
          </div>
          <footer className="wizard-shell__footer">
            {installSummary || silentInstall.status === "error" ? (
              <div className="wizard-shell__actions" style={{ marginLeft: "auto" }}>
                <Button variant="primary" onClick={() => void closeAppWindow()}>
                  Close
                </Button>
              </div>
            ) : (
              <span className="wizard-shell__step">Silent install in progress...</span>
            )}
          </footer>
        </div>
      </div>
    );
  }

  if (k2Installed && maintenanceChosen === null) {
    return (
      <div className="app-shell">
        <MaintenanceStep
          selected={maintenanceAction}
          onSelect={setMaintenanceAction}
          onContinue={() => setMaintenanceChosen(maintenanceAction)}
          installedVersion={installedVersion.status === "ready" ? installedVersion.value : null}
        />
      </div>
    );
  }

  if (maintenanceChosen === "remove") {
    return (
      <div className="app-shell">
        {removalSummary ? (
          <div className="maintenance-gate">
            <div className="maintenance-card" style={{ width: 460 }}>
              <h2 className="maintenance-card__title">
                {removalSummary.failed ? "Removal finished with errors" : "K2 removed"}
              </h2>
              <p className="maintenance-card__intro">
                {removalSummary.failed
                  ? "Some steps failed. Review the log below and re-run Remove if needed."
                  : "K2's IIS site, database, TLS setting, and service account right have been reverted."}
              </p>
              <pre className="install-console">
                {removalSummary.log.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </pre>
              <div className="maintenance-card__actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    setRemovalSummary(null);
                    setRemoveConfirmed(false);
                    setMaintenanceChosen(null);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        ) : removeConfirmed ? (
          <div className="wizard-shell">
            <div className="wizard-shell__content">
              <RemovalStep config={removeConfig} onDone={setRemovalSummary} />
            </div>
          </div>
        ) : (
          <RemoveStep
            config={removeConfig}
            onChange={setRemoveConfig}
            onConfirm={() => setRemoveConfirmed(true)}
            onCancel={() => setMaintenanceChosen(null)}
          />
        )}
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
        footer={finishedFooter}
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
