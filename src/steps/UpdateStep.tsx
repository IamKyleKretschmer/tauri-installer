import { useEffect, useRef, useState } from "react";
import { Button, TextInput, Toggle } from "../components/primitives";
import type { SqlServerConfig } from "./SqlServerStep";
import {
  findK2InstallationFolder,
  findK2ServiceAccount,
  getComputerName,
  getLatestInstallerLogLine,
  getMachineFqdn,
  getMachineKey,
  grantServiceLogonRight,
  removeLocalAdminMembership,
  runRealInstaller,
  testSqlConnection,
} from "../services/installer.service";
import { buildK2SilentInstallXml } from "../services/k2SilentInstall";

type Phase = "detecting" | "form" | "running" | "done" | "failed";

/**
 * Runs K2's own update/maintenance path against an already-installed K2,
 * instead of replaying every fresh-install step (download/extract/create
 * database/configure IIS/disable TLS) that this box already did. Detects
 * what it can from the existing install (installation folder, service
 * account, machine FQDN) and only asks for the handful of secrets that
 * can't be read back (SQL/service account passwords) before running
 * SetupManager with EXECUTION_TYPE=Update in the answer file, which lets
 * the vendor package's own targets skip work they detect is already done.
 */
export function UpdateStep({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [phase, setPhase] = useState<Phase>("detecting");
  const [installationFolder, setInstallationFolder] = useState("");
  const [hostname, setHostname] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");
  const [servicePassword, setServicePassword] = useState("");
  const [sql, setSql] = useState<SqlServerConfig>({
    instanceSource: "existing",
    instance: "localhost",
    authMode: "windows",
    username: "",
    password: "",
    databaseName: "K2",
  });
  const [statusLine, setStatusLine] = useState("Checking existing installation...");
  const [liveInstallerStatus, setLiveInstallerStatus] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const [folder, account, fqdn] = await Promise.all([
        findK2InstallationFolder(),
        findK2ServiceAccount(),
        getMachineFqdn(),
      ]);
      if (folder) setInstallationFolder(folder);
      if (account) setServiceAccount(account);
      if (fqdn) setHostname(fqdn);
      setPhase("form");
    })();
  }, []);

  function appendLog(message: string) {
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ${message}`]);
  }

  async function runUpdate() {
    setPhase("running");
    setError(null);
    setStatusLine("Verifying database connection...");
    const sqlParams = {
      instance: sql.instance,
      authMode: sql.authMode,
      username: sql.username,
      password: sql.password,
      database: sql.databaseName,
    };
    const dbCheck = await testSqlConnection(sqlParams);
    appendLog(`Database check - ${dbCheck.message}`);
    if (!dbCheck.success) {
      setError(dbCheck.message);
      setPhase("failed");
      return;
    }

    setStatusLine("Retrieving machine key...");
    const keyResult = await getMachineKey(installationFolder);
    const machineKey = keyResult.success ? keyResult.message : "";
    appendLog(
      keyResult.success ? `Machine key retrieved: ${keyResult.message}` : `Machine key retrieval failed: ${keyResult.message}`
    );

    await removeLocalAdminMembership(serviceAccount);
    await grantServiceLogonRight(serviceAccount);
    const computerName = (await getComputerName()) ?? "";

    setStatusLine("Running K2 update...");
    const xml = buildK2SilentInstallXml({
      sqlConfig: sql,
      iisConfig: {
        siteName: "K2",
        httpPort: "80",
        httpsPort: "443",
        appPoolIdentity: serviceAccount,
        sslCertificate: "",
        sourceFilesPath: "",
        packageSource: "",
        installationFolder,
      },
      adConfig: {
        serviceAccount,
        servicePassword,
        adminsGroup: "",
        createGroupIfMissing: false,
      },
      networkConfig: { hostname },
      productVersion: "",
      licenseKey: "",
      machineKey,
      computerName,
      executionType: "Update",
    });

    const pollHandle = window.setInterval(() => {
      getLatestInstallerLogLine().then((line) => {
        if (line) setLiveInstallerStatus(line);
      });
    }, 2000);
    try {
      const result = await runRealInstaller(installationFolder, xml, sqlParams);
      appendLog(result.success ? `Update - ${result.message}` : `Update - FAILED: ${result.message}`);
      if (!result.success) {
        setError(result.message);
        setPhase("failed");
        return;
      }
      setPhase("done");
    } finally {
      window.clearInterval(pollHandle);
      setLiveInstallerStatus(null);
    }
  }

  if (phase === "detecting") {
    return (
      <div className="maintenance-gate">
        <div className="maintenance-card">
          <h2 className="maintenance-card__title">Update</h2>
          <p className="maintenance-card__intro">{statusLine}</p>
        </div>
      </div>
    );
  }

  if (phase === "form") {
    const canRun = installationFolder.trim() && serviceAccount.trim() && servicePassword.trim();
    return (
      <div className="maintenance-gate">
        <div className="maintenance-card" style={{ width: 480 }}>
          <h2 className="maintenance-card__title">Update K2</h2>
          <p className="maintenance-card__intro">
            Detected from the existing installation - confirm these and provide passwords to run a faster,
            update-only pass instead of a full reinstall.
          </p>

          <TextInput
            label="Installation folder"
            value={installationFolder}
            onChange={(e) => setInstallationFolder(e.target.value)}
          />
          <TextInput label="K2 server hostname / FQDN" value={hostname} onChange={(e) => setHostname(e.target.value)} />
          <TextInput label="K2 service account" value={serviceAccount} onChange={(e) => setServiceAccount(e.target.value)} />
          <TextInput
            label="Service account password"
            type="password"
            value={servicePassword}
            onChange={(e) => setServicePassword(e.target.value)}
          />
          <TextInput
            label="SQL Server instance"
            value={sql.instance}
            onChange={(e) => setSql({ ...sql, instance: e.target.value })}
          />
          <TextInput
            label="K2 database name"
            value={sql.databaseName}
            onChange={(e) => setSql({ ...sql, databaseName: e.target.value })}
          />
          <Toggle
            checked={sql.authMode === "sql"}
            onChange={(checked) => setSql({ ...sql, authMode: checked ? "sql" : "windows" })}
            label="Use SQL Server authentication (off = Windows auth)"
          />
          {sql.authMode === "sql" && (
            <>
              <TextInput label="SQL username" value={sql.username} onChange={(e) => setSql({ ...sql, username: e.target.value })} />
              <TextInput
                label="SQL password"
                type="password"
                value={sql.password}
                onChange={(e) => setSql({ ...sql, password: e.target.value })}
              />
            </>
          )}

          <div className="maintenance-card__actions">
            <Button variant="secondary" onClick={onCancel}>
              Back
            </Button>
            <Button variant="primary" onClick={() => void runUpdate()} disabled={!canRun}>
              Run update
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="maintenance-gate">
      <div className="maintenance-card" style={{ width: 480 }}>
        <h2 className="maintenance-card__title">
          {phase === "running" ? "Updating K2" : phase === "done" ? "Update complete" : "Update failed"}
        </h2>
        <p className="maintenance-card__intro">
          {phase === "running" ? liveInstallerStatus ?? statusLine : phase === "done" ? "K2 has been updated." : error}
        </p>
        <pre className="install-console">
          {log.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </pre>
        <div className="maintenance-card__actions">
          {phase === "failed" && (
            <Button variant="secondary" onClick={() => setPhase("form")}>
              Back
            </Button>
          )}
          {phase === "done" && (
            <Button variant="primary" onClick={onDone}>
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
