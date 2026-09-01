import { useState } from "react";
import { Button, Select, TextInput } from "../components/primitives";
import "./MaintenanceStep.css";

export interface RemoveConfig {
  siteName: string;
  sqlInstance: string;
  sqlAuthMode: "sql" | "windows";
  sqlUsername: string;
  sqlPassword: string;
  databaseName: string;
  adServiceAccount: string;
}

export function RemoveStep({
  config,
  onChange,
  onConfirm,
  onCancel,
}: {
  config: RemoveConfig;
  onChange: (config: RemoveConfig) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [local, setLocal] = useState(config);

  function update(patch: Partial<RemoveConfig>) {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  }

  return (
    <div className="maintenance-gate">
      <div className="maintenance-card" style={{ width: 460 }}>
        <h2 className="maintenance-card__title">Remove K2</h2>
        <p className="maintenance-card__intro">
          This will remove the K2 IIS site and app pools, drop the K2 database, re-enable TLS 1.0/1.1, and revoke
          the service account's "Log on as a service" right. Confirm the values below match what was configured
          during install, then continue.
        </p>

        <TextInput label="IIS site name" value={local.siteName} onChange={(e) => update({ siteName: e.target.value })} />

        <TextInput
          label="SQL server instance"
          value={local.sqlInstance}
          onChange={(e) => update({ sqlInstance: e.target.value })}
        />

        <Select
          label="SQL authentication"
          value={local.sqlAuthMode}
          onChange={(e) => update({ sqlAuthMode: e.target.value as "sql" | "windows" })}
        >
          <option value="sql">SQL Server authentication</option>
          <option value="windows">Windows authentication</option>
        </Select>

        {local.sqlAuthMode === "sql" && (
          <div className="field-row">
            <TextInput
              label="SQL username"
              value={local.sqlUsername}
              onChange={(e) => update({ sqlUsername: e.target.value })}
            />
            <TextInput
              label="SQL password"
              type="password"
              value={local.sqlPassword}
              onChange={(e) => update({ sqlPassword: e.target.value })}
            />
          </div>
        )}

        <TextInput
          label="K2 database name"
          value={local.databaseName}
          onChange={(e) => update({ databaseName: e.target.value })}
        />

        <TextInput
          label="K2 service account"
          value={local.adServiceAccount}
          onChange={(e) => update({ adServiceAccount: e.target.value })}
        />

        <div className="maintenance-card__actions" style={{ justifyContent: "space-between" }}>
          <Button variant="secondary" onClick={onCancel}>
            Back
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Remove K2
          </Button>
        </div>
      </div>
    </div>
  );
}
