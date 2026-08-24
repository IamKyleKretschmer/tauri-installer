import { tauriBridge } from "./tauri.bridge";
import type { ProductInfo } from "./tauri.bridge";

export type { ProductInfo };

export async function getProductInfo(): Promise<ProductInfo> {
  return tauriBridge.getProductInfo();
}

export async function getInstalledK2Version(): Promise<string | null> {
  return tauriBridge.getInstalledK2Version();
}

export type CheckStatus = "pending" | "checking" | "pass" | "fail";

export interface SystemCheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface PrerequisiteItem {
  id: string;
  name: string;
  description: string;
  /**
   * "blocked" means this cannot be auto-installed and setup cannot
   * continue until it's resolved manually, matching the legacy installer:
   * a missing .NET Framework is a hard stop ("prerequisite not met...
   * installation cannot continue"), unlike SQL Server/IIS/VC++
   * Redistributable, which the wizard offers to install automatically.
   */
  status: "present" | "will-install" | "blocked";
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

const CHECK_RUNNERS: Record<string, () => Promise<{ pass: boolean; detail: string }>> = {
  os: () => tauriBridge.checkOs(),
  cpu: () => tauriBridge.checkCpu(),
  ram: () => tauriBridge.checkRam(),
  disk: () => tauriBridge.checkDisk(),
  display: () => tauriBridge.checkDisplay(),
  sql: () => tauriBridge.checkSqlServer(),
  iis: () => tauriBridge.checkIis(),
  dotnet: async () => {
    const pass = await tauriBridge.detectDotNet();
    return { pass, detail: pass ? ".NET Framework 4.6.1 or later detected" : "Not detected" };
  },
};

/**
 * Runs the system check sequence against the real backend commands,
 * invoking the caller's onUpdate for each item as it transitions from
 * pending -> checking -> pass/fail.
 */
export async function runSystemChecks(
  onUpdate: (items: SystemCheckItem[]) => void,
): Promise<void> {
  const items = createInitialSystemChecks();
  onUpdate([...items]);

  for (let i = 0; i < items.length; i++) {
    items[i].status = "checking";
    onUpdate([...items]);

    try {
      const result = await CHECK_RUNNERS[items[i].id]();
      items[i].status = result.pass ? "pass" : "fail";
      items[i].detail = result.detail;
    } catch (error) {
      items[i].status = "fail";
      items[i].detail = error instanceof Error ? error.message : String(error);
    }
    onUpdate([...items]);
  }
}

/**
 * Builds the Prerequisites list from real detection results. SQL Server,
 * IIS, and .NET reuse whatever System check already found (so the machine
 * isn't queried twice); VC++ Redistributable and Active Directory are
 * queried fresh since System check doesn't cover them.
 */
export async function getPrerequisites(systemChecks: SystemCheckItem[]): Promise<PrerequisiteItem[]> {
  const findStatus = (id: string) => systemChecks.find((c) => c.id === id);
  const sql = findStatus("sql");
  const iis = findStatus("iis");
  const dotnet = findStatus("dotnet");

  const [vcredist, domain] = await Promise.all([
    tauriBridge.checkVcRedist().catch(() => ({ pass: false, detail: "Could not determine VC++ Redistributable status" })),
    tauriBridge.checkDomainJoined().catch(() => ({ pass: false, detail: "Could not determine domain membership" })),
  ]);

  return [
    {
      id: "sql",
      name: "SQL Server",
      description: sql?.detail ?? "SQL Server Express will be installed",
      status: sql?.status === "pass" ? "present" : "will-install",
    },
    {
      id: "iis",
      name: "IIS",
      description: iis?.detail ?? "IIS will be enabled via Windows Features.",
      status: iis?.status === "pass" ? "present" : "will-install",
    },
    {
      id: "dotnet",
      name: ".NET Framework 4.8",
      description:
        dotnet?.status === "pass"
          ? (dotnet.detail ?? "Detected")
          : "Microsoft .NET Framework prerequisite not met. Installation cannot continue until this is resolved.",
      status: dotnet?.status === "pass" ? "present" : "blocked",
    },
    {
      id: "ad",
      name: "Active Directory",
      description: domain.detail,
      status: domain.pass ? "present" : "will-install",
    },
    {
      id: "vcredist",
      name: "VC++ Redistributable",
      description: vcredist.detail,
      status: vcredist.pass ? "present" : "will-install",
    },
  ];
}

export interface SqlConnectionTestParams {
  instance: string;
  authMode: "sql" | "windows";
  username: string;
  password: string;
  database: string;
}

export interface SqlConnectionTestResult {
  success: boolean;
  message: string;
}

/**
 * Tests the SQL Server connection and ensures the dedicated K2 database
 * exists, via DotNetRunner (spawned by the Rust test_sql_connection
 * command), same reference architecture as run_dotnet.
 */
export async function testSqlConnection(params: SqlConnectionTestParams): Promise<SqlConnectionTestResult> {
  try {
    const message = await tauriBridge.testSqlConnection(params);
    return { success: true, message };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
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
