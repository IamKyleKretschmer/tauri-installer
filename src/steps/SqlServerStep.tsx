import { useState } from "react";
import { Select, TextInput } from "../components/primitives";
import type { SqlConnectionTestResult } from "../services/installer.service";

export interface SqlServerConfig {
  instanceSource: "existing" | "new";
  instance: string;
  authMode: "sql" | "windows";
  username: string;
  password: string;
  databaseName: string;
}

export function SqlServerStep({
  config,
  onChange,
  testResult,
}: {
  config: SqlServerConfig;
  onChange: (config: SqlServerConfig) => void;
  testResult?: SqlConnectionTestResult | null;
}) {
  const [local, setLocal] = useState(config);

  function update(patch: Partial<SqlServerConfig>) {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  }

  return (
    <div>
      <h1 className="step-title step-title--sm">SQL Server configuration</h1>
      <p className="step-intro">K2 requires a SQL Server instance and a dedicated database.</p>

      <div className="callout callout--info">Collation will be set to SQL_Latin1_General_CP1_CI_AS automatically.</div>

      {testResult && (
        <div className={`callout ${testResult.success ? "callout--success" : "callout--error"}`}>
          {testResult.message}
        </div>
      )}

      <div className="toggle-row">
        <button
          className={`toggle-pill ${local.instanceSource === "existing" ? "toggle-pill--active" : ""}`}
          onClick={() => update({ instanceSource: "existing" })}
        >
          Use existing instance
        </button>
        <button
          className={`toggle-pill ${local.instanceSource === "new" ? "toggle-pill--active" : ""}`}
          onClick={() => update({ instanceSource: "new" })}
        >
          Use newly installed instance
        </button>
      </div>

      <TextInput
        label="SQL server instance"
        placeholder="e.g. SERVERNAME\SQLEXPRESS"
        hint="Leave blank for default local instance (.\SQLEXPRESS)"
        value={local.instance}
        onChange={(e) => update({ instance: e.target.value })}
      />

      <Select
        label="Authentication mode"
        hint="Leave blank for default local instance (.\SQLEXPRESS)"
        value={local.authMode}
        onChange={(e) => update({ authMode: e.target.value as SqlServerConfig["authMode"] })}
      >
        <option value="sql">SQL Server authentication</option>
        <option value="windows">Windows authentication</option>
      </Select>

      <div className="field-row">
        <TextInput
          label="Username"
          placeholder="Enter username"
          value={local.username}
          onChange={(e) => update({ username: e.target.value })}
        />
        <TextInput
          label="Password"
          type="password"
          placeholder="Enter password"
          value={local.password}
          onChange={(e) => update({ password: e.target.value })}
        />
      </div>

      <TextInput
        label="K2 database name"
        hint="A new database will be created with this name if it does not exist."
        value={local.databaseName}
        onChange={(e) => update({ databaseName: e.target.value })}
      />
    </div>
  );
}
