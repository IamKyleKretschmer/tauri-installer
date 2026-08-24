import { invoke } from "@tauri-apps/api/core";

export interface ProductInfo {
  name: string;
  version: string;
  fullVersion: string;
  installType: string;
}

interface ProductInfoRaw {
  name: string;
  version: string;
  full_version: string;
  install_type: string;
}

export interface CheckResult {
  pass: boolean;
  detail: string;
}

/**
 * Thin wrapper around Tauri's invoke(). The only module allowed to call
 * invoke() directly. Everything else goes through installer.service.ts.
 */
export const tauriBridge = {
  hello: (name: string) => invoke<string>("hello", { name }),
  getProductInfo: async (): Promise<ProductInfo> => {
    const raw = await invoke<ProductInfoRaw>("get_product_info");
    return {
      name: raw.name,
      version: raw.version,
      fullVersion: raw.full_version,
      installType: raw.install_type,
    };
  },
  detectDotNet: () => invoke<boolean>("detect_dotnet"),
  detectK2Installed: () => invoke<boolean>("detect_k2_installed"),
  getInstalledK2Version: () => invoke<string | null>("get_installed_k2_version"),
  runDotNet: (input: string) => invoke<string>("run_dotnet", { input }),
  checkOs: () => invoke<CheckResult>("check_os"),
  checkCpu: () => invoke<CheckResult>("check_cpu"),
  checkRam: () => invoke<CheckResult>("check_ram"),
  checkDisk: () => invoke<CheckResult>("check_disk"),
  checkDisplay: () => invoke<CheckResult>("check_display"),
  checkSqlServer: () => invoke<CheckResult>("check_sql_server"),
  checkIis: () => invoke<CheckResult>("check_iis"),
  checkVcRedist: () => invoke<CheckResult>("check_vc_redist"),
  checkDomainJoined: () => invoke<CheckResult>("check_domain_joined"),
};
