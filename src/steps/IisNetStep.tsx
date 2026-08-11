import { useEffect, useState } from "react";
import { Banner, Button, Select, TextInput } from "../components/primitives";
import { greetFromRust, runDotNetTask } from "../services/installer.service";
import { tauriBridge } from "../services/tauri.bridge";

export interface IisNetConfig {
  siteName: string;
  httpPort: string;
  httpsPort: string;
  appPoolIdentity: string;
  sslCertificate: string;
}

export function IisNetStep({
  config,
  onChange,
}: {
  config: IisNetConfig;
  onChange: (config: IisNetConfig) => void;
}) {
  const [local, setLocal] = useState(config);
  const [dotnetPresent, setDotnetPresent] = useState<boolean | null>(null);
  const [diagnosticsOutput, setDiagnosticsOutput] = useState("");

  useEffect(() => {
    tauriBridge
      .detectDotNet()
      .then(setDotnetPresent)
      .catch(() => setDotnetPresent(false));
  }, []);

  function update(patch: Partial<IisNetConfig>) {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  }

  async function handleRunDiagnostics() {
    const greeting = await greetFromRust(local.siteName || "K2").catch((e) => String(e));
    const runnerOutput = await runDotNetTask(local.siteName || "K2").catch((e) => `Error: ${e}`);
    setDiagnosticsOutput(`${greeting}\n${runnerOutput}`);
  }

  return (
    <div>
      <h1 className="step-title step-title--sm">IIS &amp; .NET configuration</h1>
      <p className="step-intro">Configure the web server and application pool for K2.</p>

      <Banner tone="success">
        IIS 10.0 detected and enabled. {dotnetPresent === false ? ".NET 4.8 was not detected." : ".NET 4.8 is present."}
      </Banner>

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
        <option value="*.contoso.com">*.contoso.com</option>
        <option value="self-signed">Self-signed certificate</option>
      </Select>

      <div className="panel-card">
        <h3 className="panel-card__title">Diagnostics</h3>
        <p className="step-intro" style={{ marginBottom: "0.75rem" }}>
          Verify the IPC bridge to Rust and the .NET runner before continuing.
        </p>
        <Button variant="secondary" onClick={handleRunDiagnostics}>
          Run diagnostics
        </Button>
        {diagnosticsOutput && <pre className="install-console" style={{ marginTop: "1rem" }}>{diagnosticsOutput}</pre>}
      </div>
    </div>
  );
}
