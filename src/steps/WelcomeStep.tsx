import type { LoadState, ProductInfo } from "../services/installer.service";

const WILL_DO = [
  "Check your hardware and OS compatibility",
  "Detect and install missing prerequisites (.NET, IIS, SQL Server Express)",
  "Configure SQL Server collation and database",
  "Set up IIS and application pool",
  "Configure TLS 1.2 and network settings",
  "Install K2 Server components",
];

export function WelcomeStep({
  product,
  installedVersion,
}: {
  product: LoadState<ProductInfo>;
  installedVersion: LoadState<string | null>;
}) {
  const installedLabel =
    installedVersion.status === "loading"
      ? "Checking..."
      : installedVersion.status === "error"
        ? "Unavailable (run via npm run tauri dev)"
        : installedVersion.value || "Not installed";

  const productLabel = (pick: (info: ProductInfo) => string) => {
    if (product.status === "loading") return "Checking...";
    if (product.status === "error") return "Unavailable (run via npm run tauri dev)";
    return pick(product.value);
  };

  return (
    <div>
      <h1 className="step-title">Welcome to K2 Setup</h1>
      <p className="step-intro">
        This wizard will install K2 and configure all required components on this machine. Before you begin,
        ensure you have administrator rights and network access.
      </p>

      <div className="info-grid info-grid--3">
        <div className="info-card">
          <h3>Currently installed</h3>
          <p>{installedLabel}</p>
        </div>
        <div className="info-card">
          <h3>Installing version</h3>
          <p>{productLabel((info) => info.fullVersion)}</p>
        </div>
        <div className="info-card">
          <h3>Install type</h3>
          <p>{productLabel((info) => info.installType)}</p>
        </div>
      </div>

      <div className="panel-card">
        <h3 className="panel-card__title">What this wizard will do</h3>
        <ul className="checklist">
          {WILL_DO.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
