import { useEffect, useRef, useState } from "react";
import { Banner, TextInput, Toggle } from "../components/primitives";
import type { ActionResult, CheckResult } from "../services/installer.service";
import { getDomainInfo } from "../services/installer.service";

export interface ActiveDirectoryConfig {
  serviceAccount: string;
  servicePassword: string;
  adminsGroup: string;
  createGroupIfMissing: boolean;
}

export function ActiveDirectoryStep({
  config,
  onChange,
  onLoaded,
  validationResult,
}: {
  config: ActiveDirectoryConfig;
  onChange: (config: ActiveDirectoryConfig) => void;
  onLoaded: (domain: CheckResult) => void;
  validationResult?: ActionResult | null;
}) {
  const [local, setLocal] = useState(config);
  const [domain, setDomain] = useState<CheckResult | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    getDomainInfo().then((result) => {
      setDomain(result);
      onLoaded(result);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(patch: Partial<ActiveDirectoryConfig>) {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  }

  return (
    <div>
      <h1 className="step-title step-title--sm">Active Directory</h1>
      <p className="step-intro">K2 uses AD for user authentication and group management.</p>

      <Banner tone={!domain ? "info" : domain.pass ? "success" : "warn"}>
        {domain ? domain.detail : "Checking domain membership..."}
      </Banner>

      <TextInput
        label="K2 service account"
        hint="Domain account used to run K2 services. Must have read access to AD."
        value={local.serviceAccount}
        onChange={(e) => update({ serviceAccount: e.target.value })}
      />

      <TextInput
        label="Service account password"
        type="password"
        placeholder="Enter service account password"
        value={local.servicePassword}
        onChange={(e) => update({ servicePassword: e.target.value })}
      />

      <TextInput
        label="K2 administrators group"
        hint="AD group whose members will have K2 administrator rights."
        value={local.adminsGroup}
        onChange={(e) => update({ adminsGroup: e.target.value })}
      />

      <Toggle
        checked={local.createGroupIfMissing}
        onChange={(checked) => update({ createGroupIfMissing: checked })}
        label="Create this group in AD if it does not exist"
      />

      {validationResult && (
        <div className={`callout ${validationResult.success ? "callout--info" : "callout--warn"}`}>
          {validationResult.message}
        </div>
      )}
    </div>
  );
}
