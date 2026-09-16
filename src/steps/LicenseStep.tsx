import { useEffect, useRef, useState } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { TextInput } from "../components/primitives";
import { getMachineKey, openExternalUrl } from "../services/installer.service";

/**
 * Standalone License Configuration step, matching the real K2 Setup
 * Manager's own "License Configuration" page (System Key + License Key +
 * "Request a license" link) - previously the license key field was tucked
 * onto the end of the Network & TLS step, easy to miss right before Review.
 */
export function LicenseStep({
  installationFolder,
  licenseKey,
  onLicenseKeyChange,
}: {
  installationFolder: string;
  licenseKey: string;
  onLicenseKeyChange: (value: string) => void;
}) {
  const [systemKey, setSystemKey] = useState<string | null>(null);
  const [systemKeyError, setSystemKeyError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!installationFolder.trim()) {
      setSystemKeyError("Set the installation folder on the IIS & .NET step to retrieve the real system key.");
      return;
    }
    getMachineKey(installationFolder).then((result) => {
      if (result.success) {
        setSystemKey(result.message);
      } else {
        setSystemKeyError(result.message);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLicenseKeyFocus() {
    if (licenseKey) return;
    try {
      const clipboardText = await readText();
      if (clipboardText) {
        onLicenseKeyChange(clipboardText.trim());
      }
    } catch {
      // Clipboard read can be denied/unavailable - fall back to manual paste.
    }
  }

  return (
    <div>
      <h1 className="step-title step-title--sm">License Configuration</h1>
      <p className="step-intro">Enter a valid license key to activate your installation.</p>

      <TextInput
        label="System key"
        hint="Generated from this machine - required to request a license key."
        value={systemKey ?? systemKeyError ?? "Retrieving system key..."}
        readOnly
      />

      <TextInput
        label="License key"
        hint="Click into the field to paste from your clipboard automatically."
        value={licenseKey}
        onChange={(e) => onLicenseKeyChange(e.target.value)}
        onFocus={handleLicenseKeyFocus}
      />

      <p className="step-intro">
        Don't have a license key?{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            openExternalUrl("https://customer.nintex.com/products/Pages/License-Management.aspx?ref=installer");
          }}
        >
          Request a license
        </a>
      </p>
    </div>
  );
}
