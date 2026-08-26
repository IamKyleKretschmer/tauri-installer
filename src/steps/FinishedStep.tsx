import { useEffect, useRef, useState } from "react";
import { Button } from "../components/primitives";
import type { PrerequisiteItem, ProductInfo } from "../services/installer.service";
import { openExternalUrl, openLocalPath, saveInstallLog } from "../services/installer.service";
import type { SqlServerConfig } from "./SqlServerStep";
import type { IisNetConfig } from "./IisNetStep";

export interface FinishedSummary {
  product: ProductInfo | null;
  prerequisiteItems: PrerequisiteItem[] | null;
  sqlConfig: SqlServerConfig;
  sqlResultMessage: string | null;
  iisConfig: IisNetConfig;
  adServiceAccount: string;
  hostname: string;
  log: string[];
  elapsedMs: number;
  stepCount: number;
}

function prerequisiteLabel(items: PrerequisiteItem[] | null, id: string, installedLabel: string): string {
  const item = items?.find((i) => i.id === id);
  if (!item) return installedLabel;
  return item.status === "present" ? "Already present" : installedLabel;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function FinishedStep({ summary }: { summary: FinishedSummary }) {
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const header = `K2 Setup log\nCompleted in ${formatElapsed(summary.elapsedMs)}\n\n`;
    saveInstallLog(header + summary.log.join("\n")).then((result) => {
      if (result.success) {
        setLogPath(result.message);
      } else {
        setLogError(result.message);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const managementUrl = `https://${summary.hostname}/Management`;
  const designerUrl = `https://${summary.hostname}/Designer`;

  const rows: [string, string][] = [
    ["VC++ Redistributable 2019", prerequisiteLabel(summary.prerequisiteItems, "vcredist", "Installed")],
    ["IIS 10.0", prerequisiteLabel(summary.prerequisiteItems, "iis", "Installed & configured")],
    ["SQL Server Express 2019", prerequisiteLabel(summary.prerequisiteItems, "sql", "Installed")],
    [
      `K2 database (SQL_Latin1_General_CP1_CI_AS)`,
      summary.sqlResultMessage?.toLowerCase().includes("created") ? "Created" : "Verified",
    ],
    ["TLS 1.2 enforced, TLS 1.0/1.1 disabled", "Configured"],
    [`IIS site '${summary.iisConfig.siteName}' on ports ${summary.iisConfig.httpPort} / ${summary.iisConfig.httpsPort}`, "Configured"],
    [`AD service account ${summary.adServiceAccount}`, "Configured"],
    [`${summary.product?.fullVersion ?? "K2"} server components`, "Installed"],
    ["K2 Windows services", "Running"],
  ];

  return (
    <div className="finished-step">
      <div className="finished-step__badge">✓</div>
      <h1 className="finished-step__title">K2 is ready</h1>
      <p className="finished-step__subtitle">
        {summary.product?.fullVersion ?? "K2"} has been installed and all services are running. You can close this
        wizard and open the K2 Management site.
      </p>

      <div className="info-grid">
        <div className="info-card">
          <h3>K2 Management Site</h3>
          <p>
            <button className="link-button" onClick={() => void openExternalUrl(managementUrl)}>
              {managementUrl}
            </button>
          </p>
          <p className="step-intro" style={{ marginBottom: 0 }}>
            Opens in your default browser
          </p>
        </div>
        <div className="info-card">
          <h3>K2 Designer</h3>
          <p>
            <button className="link-button" onClick={() => void openExternalUrl(designerUrl)}>
              {designerUrl}
            </button>
          </p>
          <p className="step-intro" style={{ marginBottom: 0 }}>
            Opens in your default browser
          </p>
        </div>
      </div>

      <div className="panel-card">
        <h3 className="panel-card__title">What was installed and configured</h3>
        <div className="finished-step__rows">
          {rows.map(([label, value]) => (
            <div className="finished-step__row" key={label}>
              <span>{label}</span>
              <span className="finished-step__row-status">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="finished-step__log-card">
        <div>
          <h3 className="panel-card__title">Installation log</h3>
          <p className="step-intro" style={{ marginBottom: 0 }}>
            {logPath ? logPath : logError ? `Could not save log: ${logError}` : "Saving..."}
          </p>
        </div>
        <Button variant="secondary" disabled={!logPath} onClick={() => logPath && void openLocalPath(logPath)}>
          Open log
        </Button>
      </div>
    </div>
  );
}

export { formatElapsed };
