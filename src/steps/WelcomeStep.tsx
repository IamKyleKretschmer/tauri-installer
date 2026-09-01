import { Select } from "../components/primitives";
import type { LoadState, ProductInfo } from "../services/installer.service";

// Mirrors the version choices AutomateK2Install_v4.7.ps1 offers when
// picking a build to download (K2 Five 5.6, 5.9.1, 5.10, ...). POC only:
// this just changes the displayed version and install-log text, it does
// not fetch or install a different real payload.
export const AVAILABLE_VERSIONS = ["5.10", "5.9.1", "5.6"];

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
  selectedVersion,
  onVersionChange,
}: {
  product: LoadState<ProductInfo>;
  installedVersion: LoadState<string | null>;
  selectedVersion: string;
  onVersionChange: (version: string) => void;
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

  const productName = product.status === "ready" ? product.value.name : "K2 Five";

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
          {product.status === "ready" ? (
            <Select
              value={selectedVersion}
              onChange={(e) => onVersionChange(e.target.value)}
            >
              {AVAILABLE_VERSIONS.map((v) => (
                <option key={v} value={v}>
                  {productName} {v}
                </option>
              ))}
            </Select>
          ) : (
            <p>{productLabel((info) => info.fullVersion)}</p>
          )}
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
