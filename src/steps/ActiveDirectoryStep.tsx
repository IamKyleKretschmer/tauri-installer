import { useState } from "react";
import { TextInput } from "../components/primitives";

export function ActiveDirectoryStep() {
  const [domain, setDomain] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");

  return (
    <div>
      <h1 className="step-title step-title--sm">Active Directory</h1>
      <p className="step-intro">
        K2 uses a domain service account to run its core services. Domain membership was detected in the
        prerequisites check.
      </p>

      <TextInput
        label="Domain"
        placeholder="e.g. corp.example.com"
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
      />
      <TextInput
        label="K2 service account"
        placeholder="DOMAIN\svc-k2"
        value={serviceAccount}
        onChange={(e) => setServiceAccount(e.target.value)}
      />
    </div>
  );
}
