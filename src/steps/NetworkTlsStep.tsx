import { useState } from "react";
import { TextInput } from "../components/primitives";

export function NetworkTlsStep() {
  const [port, setPort] = useState("443");
  const [hostname, setHostname] = useState("");

  return (
    <div>
      <h1 className="step-title step-title--sm">Network &amp; TLS</h1>
      <p className="step-intro">TLS 1.2 will be enforced for all K2 endpoints.</p>

      <div className="callout callout--info">TLS 1.0 and 1.1 will be disabled on this server.</div>

      <TextInput label="HTTPS port" value={port} onChange={(e) => setPort(e.target.value)} />
      <TextInput
        label="Public hostname"
        placeholder="k2.corp.example.com"
        value={hostname}
        onChange={(e) => setHostname(e.target.value)}
      />
    </div>
  );
}
