import type { SqlServerConfig } from "./SqlServerStep";
import type { IisNetConfig } from "./IisNetStep";
import type { ActiveDirectoryConfig } from "./ActiveDirectoryStep";
import type { NetworkTlsConfig } from "./NetworkTlsStep";
import type { ActionResult, CertificateInfo, CheckResult, NetworkChecks } from "../services/installer.service";
import { getReviewChecklist } from "../services/installer.service";
import { TextInput } from "../components/primitives";

function ReviewCard({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="panel-card review-card">
      <h3 className="panel-card__title">{title}</h3>
      <dl className="review-card__list">
        {rows.map(([label, value]) => (
          <div className="review-card__row" key={label}>
            <dt>{label}:</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ReviewStep({
  sqlConfig,
  iisConfig,
  adConfig,
  networkConfig,
  domain,
  networkChecks,
  certificates,
  sqlTestResult,
  portTestResult,
  licenseKey,
  onLicenseKeyChange,
  machineKey,
  onMachineKeyChange,
}: {
  sqlConfig: SqlServerConfig;
  iisConfig: IisNetConfig;
  adConfig: ActiveDirectoryConfig;
  networkConfig: NetworkTlsConfig;
  domain: CheckResult | null;
  networkChecks: NetworkChecks | null;
  certificates: CertificateInfo[];
  sqlTestResult: ActionResult | null;
  portTestResult: ActionResult | null;
  licenseKey: string;
  onLicenseKeyChange: (value: string) => void;
  machineKey: string;
  onMachineKeyChange: (value: string) => void;
}) {
  const certificateLabel = iisConfig.sslCertificate
    ? (certificates.find((c) => c.thumbprint === iisConfig.sslCertificate)?.subject ?? iisConfig.sslCertificate)
    : "None selected";

  const checklist = getReviewChecklist({
    sqlTestResult,
    siteName: iisConfig.siteName,
    portTestResult,
    serviceAccount: adConfig.serviceAccount,
    adminsGroup: adConfig.adminsGroup,
    hostname: networkConfig.hostname,
  });
  const allPass = checklist.every((item) => item.pass);

  return (
    <div>
      <h1 className="step-title step-title--sm">Review &amp; confirm</h1>
      <p className="step-intro">Review your settings before installation begins. Click Back to make changes.</p>

      <div className="panel-card">
        <h3 className="panel-card__title">Readiness checklist</h3>
        <p className="step-intro" style={{ marginBottom: "0.75rem" }}>
          {allPass
            ? "Everything looks good. You can install K2 now."
            : "Resolve the items below before installing, an incorrect or missing value here can cause the install to fail partway through."}
        </p>
        <div className="checklist-items">
          {checklist.map((item) => (
            <div className="checklist-item" key={item.id}>
              <span className={`checklist-item__icon ${item.pass ? "checklist-item__icon--pass" : "checklist-item__icon--fail"}`}>
                {item.pass ? "✓" : "✗"}
              </span>
              <div>
                <div className="checklist-item__label">{item.label}</div>
                <div className="checklist-item__detail">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {iisConfig.installationFolder && (
        <div className="panel-card">
          <h3 className="panel-card__title">Real installer license key</h3>
          <p className="step-intro" style={{ marginBottom: "0.75rem" }}>
            A real installation folder is configured, so the Install step will run the real SourceCode.SetupManager.exe /
            Setup.exe against a generated silent-install answer file. Enter a valid license key for that run. It is used only
            for this install and is never saved to the blueprint file.
          </p>
          <TextInput
            label="License key"
            type="password"
            value={licenseKey}
            onChange={(e) => onLicenseKeyChange(e.target.value)}
          />

          <TextInput
            label="Machine key (optional)"
            hint={
              'Retrieved via ".\\Setup.exe /noui /systemkey" on this machine. If set, this exact key is reused on every ' +
              "real install run, so the K2 database's encrypted contents stay decryptable across attempts and the database " +
              "is reused instead of dropped and recreated. Leave blank to keep the current behavior: a fresh key is " +
              "generated each run and the database is dropped first so it doesn't conflict with the previous run's key."
            }
            value={machineKey}
            onChange={(e) => onMachineKeyChange(e.target.value)}
          />
        </div>
      )}

      <div className="review-grid">
        <ReviewCard
          title="SQL Server"
          rows={[
            ["Instance", sqlConfig.instance || ".\\SQLEXPRESS"],
            ["Database", sqlConfig.databaseName || "K2"],
            ["Auth", sqlConfig.authMode === "sql" ? `SQL auth (${sqlConfig.username || "sa"})` : "Windows auth"],
            ["Collation", "SQL_Latin1_General_CP1_CI_AS"],
          ]}
        />
        <ReviewCard
          title="IIS & Web"
          rows={[
            ["Site", iisConfig.siteName || "K2"],
            ["Ports", `${iisConfig.httpPort || "80"} / ${iisConfig.httpsPort || "443"}`],
            ["Certificate", certificateLabel],
            ["App pool", iisConfig.appPoolIdentity || "NetworkService"],
          ]}
        />
        <ReviewCard
          title="Active Directory"
          rows={[
            ["Domain", domain?.pass ? (domain.detail.match(/Domain detected: ([^.]+\.\S+)\./)?.[1] ?? domain.detail) : "Not domain-joined"],
            ["Service account", adConfig.serviceAccount || "CONTOSO\\svc-k2"],
            ["Admin group", adConfig.adminsGroup || "CONTOSO\\K2Admins"],
          ]}
        />
        <ReviewCard
          title="Network"
          rows={[
            ["Hostname", networkConfig.hostname || "k2server.contoso.local"],
            ["TLS 1.2", networkChecks ? (networkChecks.tls12.pass ? "Enabled" : "Disabled") : "Checking..."],
            [
              "TLS 1.0/1.1",
              networkChecks ? (networkChecks.tlsLegacy.pass ? "Already disabled" : "Will be disabled") : "Checking...",
            ],
          ]}
        />
      </div>
    </div>
  );
}
