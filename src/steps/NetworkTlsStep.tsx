import { useEffect, useRef, useState } from "react";
import { Badge, TextInput } from "../components/primitives";
import type { NetworkChecks } from "../services/installer.service";
import { getMachineFqdn, getNetworkChecks } from "../services/installer.service";

export interface NetworkTlsConfig {
  hostname: string;
}

export function NetworkTlsStep({
  config,
  onChange,
  onLoaded,
}: {
  config: NetworkTlsConfig;
  onChange: (config: NetworkTlsConfig) => void;
  onLoaded: (checks: NetworkChecks) => void;
}) {
  const [local, setLocal] = useState(config);
  const [checks, setChecks] = useState<NetworkChecks | null>(null);
  const userEditedHostname = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    Promise.all([getNetworkChecks(), getMachineFqdn()]).then(([networkChecks, fqdn]) => {
      setChecks(networkChecks);
      onLoaded(networkChecks);
      if (fqdn && !userEditedHostname.current) {
        update({ hostname: fqdn });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(patch: Partial<NetworkTlsConfig>) {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  }

  function handleHostnameChange(value: string) {
    userEditedHostname.current = true;
    update({ hostname: value });
  }

  const rows = checks
    ? [
        {
          id: "tls12",
          label: "TLS 1.2",
          description: checks.tls12.detail,
          pass: checks.tls12.pass,
          badge: checks.tls12.pass ? "Enabled" : "Disabled",
        },
        {
          id: "tls-legacy",
          label: "TLS 1.0 / 1.1",
          description: checks.tlsLegacy.detail,
          pass: checks.tlsLegacy.pass,
          badge: checks.tlsLegacy.pass ? "Disabled" : "Will disable",
        },
        {
          id: "ipv4",
          label: "IPv4",
          description: checks.ipv4.detail,
          pass: checks.ipv4.pass,
          badge: checks.ipv4.pass ? "Present" : "Not detected",
        },
        {
          id: "ipv6-only",
          label: "IPv6-only mode",
          description: checks.ipv4.pass
            ? "Not detected. IPv4 is the active stack."
            : "IPv6-only detected. K2 requires IPv4.",
          pass: checks.ipv4.pass,
          badge: checks.ipv4.pass ? "Not active" : "Active",
        },
      ]
    : [];

  return (
    <div>
      <h1 className="step-title step-title--sm">Network &amp; TLS</h1>
      <p className="step-intro">K2 requires TLS 1.2 and IPv4. We'll verify and configure these now.</p>

      <div className="prereq-list">
        {checks ? (
          rows.map((row) => (
            <div className="prereq-row" key={row.id}>
              <div>
                <div className="prereq-row__name">{row.label}</div>
                <div className="prereq-row__desc">{row.description}</div>
              </div>
              <Badge tone={row.pass ? "pass" : "caution"}>{row.badge}</Badge>
            </div>
          ))
        ) : (
          <p className="step-intro">Checking TLS and network configuration...</p>
        )}
      </div>

      <TextInput
        label="K2 server hostname / FQDN"
        hint="Used to generate service URLs. Must match your SSL certificate's CN or SAN."
        value={local.hostname}
        onChange={(e) => handleHostnameChange(e.target.value)}
      />
    </div>
  );
}
