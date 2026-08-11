import { useEffect, useState } from "react";
import { Button, TextInput } from "../components/primitives";
import { greetFromRust, runDotNetTask } from "../services/installer.service";
import { tauriBridge } from "../services/tauri.bridge";

export function IisNetStep() {
  const [appPool, setAppPool] = useState("K2AppPool");
  const [dotnetInput, setDotnetInput] = useState("");
  const [output, setOutput] = useState("");
  const [dotnetPresent, setDotnetPresent] = useState<boolean | null>(null);

  useEffect(() => {
    tauriBridge
      .detectDotNet()
      .then(setDotnetPresent)
      .catch(() => setDotnetPresent(false));
  }, []);

  async function handleGreet() {
    const result = await greetFromRust(appPool || "K2").catch((e) => String(e));
    setOutput(result);
  }

  async function handleRunDotNet() {
    const result = await runDotNetTask(dotnetInput || "ping").catch((e) => `Error: ${e}`);
    setOutput(result);
  }

  return (
    <div>
      <h1 className="step-title step-title--sm">IIS &amp; .NET configuration</h1>
      <p className="step-intro">Configure the application pool that will host K2, and verify the IPC bridge to .NET.</p>

      <TextInput label="Application pool name" value={appPool} onChange={(e) => setAppPool(e.target.value)} />

      <div className="panel-card">
        <h3 className="panel-card__title">.NET Framework status</h3>
        <p className="step-intro" style={{ marginBottom: 0 }}>
          {dotnetPresent === null ? "Checking…" : dotnetPresent ? ".NET Framework 4.8 detected." : ".NET Framework 4.8 not detected."}
        </p>
      </div>

      <div className="panel-card">
        <h3 className="panel-card__title">IPC bridge test</h3>
        <div className="field-row">
          <TextInput
            label="Message to Rust"
            placeholder="Enter a name"
            value={dotnetInput}
            onChange={(e) => setDotnetInput(e.target.value)}
          />
        </div>
        <div className="wizard-shell__actions" style={{ marginBottom: "1rem" }}>
          <Button variant="secondary" onClick={handleGreet}>
            Call Rust command
          </Button>
          <Button variant="primary" onClick={handleRunDotNet}>
            Run DotNetRunner.exe
          </Button>
        </div>
        {output && <pre className="install-console">{output}</pre>}
      </div>
    </div>
  );
}
