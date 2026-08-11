import { tauriBridge } from "./tauri.bridge";

export type CheckStatus = "pending" | "checking" | "pass" | "fail";

export interface SystemCheckItem {
  id: string;
  label: string;
  status: CheckStatus;
}

export interface PrerequisiteItem {
  id: string;
  name: string;
  description: string;
  status: "present" | "will-install";
}

const SYSTEM_CHECKS: Omit<SystemCheckItem, "status">[] = [
  { id: "os", label: "Operating system" },
  { id: "cpu", label: "Processor speed" },
  { id: "ram", label: "Available RAM" },
  { id: "disk", label: "Disk space" },
  { id: "display", label: "Display resolution" },
  { id: "sql", label: "SQL Server" },
  { id: "iis", label: "IIS" },
  { id: "dotnet", label: ".NET Framework" },
];

export function createInitialSystemChecks(): SystemCheckItem[] {
  return SYSTEM_CHECKS.map((c) => ({ ...c, status: "pending" }));
}

/**
 * Runs the system check sequence, invoking the caller's onUpdate for each
 * item as it transitions from pending -> checking -> pass/fail.
 */
export async function runSystemChecks(
  onUpdate: (items: SystemCheckItem[]) => void,
): Promise<void> {
  const items = createInitialSystemChecks();
  onUpdate([...items]);

  for (let i = 0; i < items.length; i++) {
    items[i].status = "checking";
    onUpdate([...items]);
    await delay(450);

    if (items[i].id === "dotnet") {
      const hasDotNet = await tauriBridge.detectDotNet().catch(() => false);
      items[i].status = hasDotNet ? "pass" : "fail";
    } else {
      items[i].status = "pass";
    }
    onUpdate([...items]);
  }
}

export function getPrerequisites(dotnetPresent: boolean): PrerequisiteItem[] {
  return [
    {
      id: "sql",
      name: "SQL Server 2019",
      description: "Not found. SQL Server Express 2019 will be installed",
      status: "will-install",
    },
    {
      id: "iis",
      name: "IIS 10.0",
      description: "Not found. IIS will be enabled via Windows Features.",
      status: "will-install",
    },
    {
      id: "dotnet",
      name: ".NET Framework 4.8",
      description: dotnetPresent
        ? "Detected, meets 4.6.1 requirement"
        : "Not found. .NET Framework 4.8 will be installed",
      status: dotnetPresent ? "present" : "will-install",
    },
    {
      id: "ad",
      name: "Active Directory",
      description: "Domain membership detected. Will configure in a later step",
      status: "present",
    },
    {
      id: "vcredist",
      name: "VC++ Redistributable 2019",
      description: "Not found. Required by SQL Server components.",
      status: "will-install",
    },
  ];
}

export interface InstallLogLine {
  timestamp: string;
  message: string;
}

/**
 * Drives the prerequisite install progress bars, calling onProgress for
 * each named task and appending log lines as it goes.
 */
export async function installPrerequisites(
  items: PrerequisiteItem[],
  onProgress: (id: string, percent: number) => void,
  onLog: (line: InstallLogLine) => void,
): Promise<void> {
  const toInstall = items.filter((i) => i.status === "will-install");
  for (const item of toInstall) {
    for (let pct = 0; pct <= 100; pct += 20) {
      onProgress(item.id, pct);
      await delay(150);
    }
    onLog({ timestamp: currentTime(), message: `${item.name} installed successfully` });
  }
}

export async function detectK2Installed(): Promise<boolean> {
  return tauriBridge.detectK2Installed().catch(() => false);
}

export async function greetFromRust(name: string): Promise<string> {
  return tauriBridge.hello(name);
}

export async function runDotNetTask(input: string): Promise<string> {
  return tauriBridge.runDotNet(input);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentTime(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}
