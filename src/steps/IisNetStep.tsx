import { useEffect, useRef, useState } from "react";
import { Banner, Select, TextInput } from "../components/primitives";
import type { ActionResult, IisChecks } from "../services/installer.service";
import { getIisChecks } from "../services/installer.service";

export interface IisNetConfig {
  siteName: string;
  httpPort: string;
  httpsPort: string;
  appPoolIdentity: string;
  sslCertificate: string;
  sourceFilesPath: string;
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

      <TextInput
        label="K2 source files folder (optional)"
        hint="A local folder or share containing the K2 server/web files to deploy (e.g. sourcecode.dll). Leave blank to skip file deployment; the IIS folders will still be created but left empty."
        value={local.sourceFilesPath}
        onChange={(e) => update({ sourceFilesPath: e.target.value })}
      />
    </div>
  );
}
