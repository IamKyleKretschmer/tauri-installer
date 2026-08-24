import { useEffect, useState } from "react";
import type { ProductInfo } from "../services/installer.service";
import { getInstalledK2Version, getProductInfo } from "../services/installer.service";

const WILL_DO = [
  "Check your hardware and OS compatibility",
  "Detect and install missing prerequisites (.NET, IIS, SQL Server Express)",
  "Configure SQL Server collation and database",
  "Set up IIS and application pool",
  "Configure TLS 1.2 and network settings",
  "Install K2 Server components",
];

export function WelcomeStep() {
  const [product, setProduct] = useState<ProductInfo | null>(null);
  const [installedVersion, setInstalledVersion] = useState<string | null | "checking">("checking");

  useEffect(() => {
    getProductInfo()
      .then(setProduct)
      .catch(() => setProduct(null));
    getInstalledK2Version().then(setInstalledVersion);
  }, []);

  const installedLabel = installedVersion === "checking" ? "Checking..." : installedVersion || "Not installed";

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
          <p>{product ? product.fullVersion : "Checking..."}</p>
        </div>
        <div className="info-card">
          <h3>Install type</h3>
          <p>{product ? product.installType : "Checking..."}</p>
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
