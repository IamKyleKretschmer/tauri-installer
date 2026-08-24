import { useEffect, useState } from "react";
import { Button } from "../components/primitives";
import { getInstalledK2Version } from "../services/installer.service";
import "./MaintenanceStep.css";

export type MaintenanceAction = "configure" | "modify" | "remove" | "update";

const OPTIONS: { id: MaintenanceAction; label: string }[] = [
  { id: "configure", label: "Configure" },
  { id: "modify", label: "Modify" },
  { id: "remove", label: "Remove" },
  { id: "update", label: "Update" },
];

export function MaintenanceStep({
  selected,
  onSelect,
  onContinue,
}: {
  selected: MaintenanceAction;
  onSelect: (action: MaintenanceAction) => void;
  onContinue: () => void;
}) {
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);

  useEffect(() => {
    getInstalledK2Version()
      .then(setInstalledVersion)
      .catch(() => setInstalledVersion(null));
  }, []);

  return (
    <div className="maintenance-gate">
      <div className="maintenance-card">
        <h2 className="maintenance-card__title">Maintenance</h2>
        <p className="maintenance-card__intro">
          K2 {installedVersion ? `(version ${installedVersion}) ` : ""}is already installed on this machine.
          Choose what you would like to do.
        </p>

        <div className="maintenance-options">
          {OPTIONS.map((option) => (
            <label className="maintenance-option" key={option.id}>
              <input
                type="radio"
                name="maintenance-action"
                checked={selected === option.id}
                onChange={() => onSelect(option.id)}
              />
              <span className="maintenance-option__control" />
              <span>{option.label}</span>
            </label>
          ))}
        </div>

        <div className="maintenance-card__actions">
          <Button variant="primary" onClick={onContinue}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
