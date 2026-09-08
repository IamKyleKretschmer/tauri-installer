import { useEffect, useRef, useState } from "react";
import { Banner, Select, TextInput } from "../components/primitives";
import type { ActionResult, IisChecks } from "../services/installer.service";
import { findK2InstallationFolder, getIisChecks } from "../services/installer.service";

export interface IisNetConfig {
  siteName: string;
  httpPort: string;
  httpsPort: string;
  appPoolIdentity: string;
  sslCertificate: string;
  sourceFilesPath: string;
  packageSource: string;
  installationFolder: string;
}

export function IisNetStep({
  config,
  onChange,
  onLoaded,
  portTestResult,
}: {
  config: IisNetConfig;
  onChange: (config: IisNetConfig) => void;
  onLoaded: (checks: IisChecks) => void;
  portTestResult?: ActionResult | null;
}) {
  const [local, setLocal] = useState(config);
  const [checks, setChecks] = useState<IisChecks | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    getIisChecks().then((result) => {
      setChecks(result);
      onLoaded(result);
      // Default to a real detected certificate instead of leaving this
      // on "Select from store" when one is available.
      if (!local.sslCertificate && result.certificates.length > 0) {
        update({ sslCertificate: result.certificates[0].thumbprint });
      }
    });
    // Looks for an already-extracted real K2 build (e.g. on the Desktop
    // or in Downloads) so the operator never has to type its path in -
    // silently does nothing if none is found, since most environments
    // won't have one and should keep working exactly as before.
    findK2InstallationFolder().then((path) => {
      if (path) update({ installationFolder: path });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(patch: Partial<IisNetConfig>) {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  }

  const bannerTone = checks && checks.iis.pass && checks.dotnet.pass ? "success" : "warn";
  const bannerText = !checks
    ? "Checking IIS and .NET status..."
    : `${checks.iis.pass ? "IIS is installed and enabled." : "IIS was not detected. It will be enabled via Windows Features."} ${
        checks.dotnet.pass ? ".NET Framework is present." : ".NET Framework was not detected."
      }`;

  return (
    <div>
      <h1 className="step-title step-title--sm">IIS &amp; .NET configuration</h1>
      <p className="step-intro">Configure the web server and application pool for K2.</p>

      <Banner tone={bannerTone}>{bannerText}</Banner>

      {checks && (
        <div className="panel-card">
          <h3 className="panel-card__title">Additional K2 prerequisites</h3>
          <div className="checklist-items">
            <div className="checklist-item">
              <span
                className={`checklist-item__icon ${checks.httpActivation.pass ? "checklist-item__icon--pass" : "checklist-item__icon--fail"}`}
              >
                {checks.httpActivation.pass ? "✓" : "✗"}
              </span>
              <div>
                <div className="checklist-item__label">WCF HTTP Activation</div>
                <div className="checklist-item__detail">{checks.httpActivation.detail}</div>
              </div>
            </div>
            <div className="checklist-item">
              <span
                className={`checklist-item__icon ${checks.msdtc.pass ? "checklist-item__icon--pass" : "checklist-item__icon--fail"}`}
              >
                {checks.msdtc.pass ? "✓" : "✗"}
              </span>
              <div>
                <div className="checklist-item__label">Distributed Transaction Coordinator</div>
                <div className="checklist-item__detail">{checks.msdtc.detail}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <TextInput label="IIS site name" value={local.siteName} onChange={(e) => update({ siteName: e.target.value })} />

      <div className="field-row">
        <TextInput label="HTTP port" value={local.httpPort} onChange={(e) => update({ httpPort: e.target.value })} />
        <TextInput label="HTTPS port" value={local.httpsPort} onChange={(e) => update({ httpsPort: e.target.value })} />
      </div>

      <Select
        label="Application pool identity"
        value={local.appPoolIdentity}
        onChange={(e) => update({ appPoolIdentity: e.target.value })}
      >
        <option>NetworkService</option>
        <option>ApplicationPoolIdentity</option>
        <option>Custom account</option>
      </Select>

      <Select
        label="SSL certificate"
        hint="Trusted CA certificates are strongly recommended. Self-signed certs may cause errors with SharePoint Online."
        value={local.sslCertificate}
        onChange={(e) => update({ sslCertificate: e.target.value })}
      >
        <option value="">Select from store</option>
        {checks?.certificates.map((cert) => (
          <option key={cert.thumbprint} value={cert.thumbprint}>
            {cert.subject}
          </option>
        ))}
      </Select>

      {portTestResult && !portTestResult.success && (
        <div className="callout callout--warn">{portTestResult.message}</div>
      )}
    </div>
  );
}
