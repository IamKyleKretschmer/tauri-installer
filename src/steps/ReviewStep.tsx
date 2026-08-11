import type { SqlServerConfig } from "./SqlServerStep";
import type { IisNetConfig } from "./IisNetStep";
import type { ActiveDirectoryConfig } from "./ActiveDirectoryStep";
import type { NetworkTlsConfig } from "./NetworkTlsStep";

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
}: {
  sqlConfig: SqlServerConfig;
  iisConfig: IisNetConfig;
  adConfig: ActiveDirectoryConfig;
  networkConfig: NetworkTlsConfig;
}) {
  return (
    <div>
      <h1 className="step-title step-title--sm">Review &amp; confirm</h1>
      <p className="step-intro">Review your settings before installation begins. Click Back to make changes.</p>

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
            ["Certificate", iisConfig.sslCertificate || "*.contoso.com"],
            ["App pool", iisConfig.appPoolIdentity || "NetworkService"],
          ]}
        />
        <ReviewCard
          title="Active Directory"
          rows={[
            ["Domain", "contoso.local"],
            ["Service account", adConfig.serviceAccount || "CONTOSO\\svc-k2"],
            ["Admin group", adConfig.adminsGroup || "CONTOSO\\K2Admins"],
          ]}
        />
        <ReviewCard
          title="Network"
          rows={[
            ["Hostname", networkConfig.hostname || "k2server.contoso.local"],
            ["TLS 1.2", "Enabled"],
            ["TLS 1.0/1.1", "Will be disabled"],
          ]}
        />
      </div>
    </div>
  );
}
