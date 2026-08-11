import type { SqlServerConfig } from "./SqlServerStep";

export function ReviewStep({ sqlConfig }: { sqlConfig: SqlServerConfig }) {
  const rows: [string, string][] = [
    ["Installing version", "K2 Five 5.10"],
    ["Install type", "Full server install"],
    ["SQL server instance", sqlConfig.instance || "(default) .\\SQLEXPRESS"],
    ["K2 database name", sqlConfig.databaseName || "K2"],
    ["Authentication mode", sqlConfig.authMode === "sql" ? "SQL Server authentication" : "Windows authentication"],
  ];

  return (
    <div>
      <h1 className="step-title step-title--sm">Review</h1>
      <p className="step-intro">Confirm your settings before K2 setup begins.</p>

      <div className="panel-card">
        <table className="review-table">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
