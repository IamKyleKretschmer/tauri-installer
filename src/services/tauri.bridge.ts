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
};
