import { useState } from "react";
import { Badge, TextInput } from "../components/primitives";

export interface NetworkTlsConfig {
  hostname: string;
}

const CHECKS: { id: string; label: string; description: string; tone: "pass" | "caution"; badge: string }[] = [
  {
    id: "tls12",
    label: "TLS 1.2",
    description: "Detected as enabled in Schannel registry",
    tone: "pass",
    badge: "Enabled",
  },
  {
    id: "tls-legacy",
    label: "TLS 1.0 / 1.1",
    description: "Currently enabled. K2 requires these to be disabled.",
    tone: "caution",
    badge: "Will disable",
  },
  {
    id: "ipv4",
    label: "IPv4",
    description: "IPv4 active on primary adapter (192.168.1.50)",
    tone: "pass",
    badge: "Present",
  },
  {
    id: "ipv6-only",
    label: "IPv6-only mode",
    description: "Not detected. IPv4 is the active stack.",
    tone: "pass",
    badge: "Not active",
  },
];

export function NetworkTlsStep({
  config,
  onChange,
}: {
  config: NetworkTlsConfig;
  onChange: (config: NetworkTlsConfig) => void;
}) {
  const [local, setLocal] = useState(config);

  function update(patch: Partial<NetworkTlsConfig>) {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  }

  return (
    <div>
      <h1 className="step-title step-title--sm">Network &amp; TLS</h1>
      <p className="step-intro">K2 requires TLS 1.2 and IPv4. We'll verify and configure these now.</p>

      <div className="prereq-list">
        {CHECKS.map((check) => (
          <div className="prereq-row" key={check.id}>
            <div>
              <div className="prereq-row__name">{check.label}</div>
              <div className="prereq-row__desc">{check.description}</div>
            </div>
            <Badge tone={check.tone}>{check.badge}</Badge>
          </div>
        ))}
      </div>

      <TextInput
        label="K2 server hostname / FQDN"
        hint="Used to generate service URLs. Must match your SSL certificate's CN or SAN."
        value={local.hostname}
        onChange={(e) => update({ hostname: e.target.value })}
      />
    </div>
  );
}
