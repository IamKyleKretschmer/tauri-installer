import { useState } from "react";
import { Banner, TextInput, Toggle } from "../components/primitives";

export interface ActiveDirectoryConfig {
  serviceAccount: string;
  servicePassword: string;
  adminsGroup: string;
  createGroupIfMissing: boolean;
}

export function ActiveDirectoryStep({
  config,
  onChange,
}: {
  config: ActiveDirectoryConfig;
  onChange: (config: ActiveDirectoryConfig) => void;
}) {
  const [local, setLocal] = useState(config);

  function update(patch: Partial<ActiveDirectoryConfig>) {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  }

  return (
    <div>
      <h1 className="step-title step-title--sm">Active Directory</h1>
      <p className="step-intro">K2 uses AD for user authentication and group management.</p>

      <Banner tone="success">Domain detected: contoso.local. This machine is domain-joined.</Banner>

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
    </div>
  );
}
