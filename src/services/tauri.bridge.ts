import { invoke } from "@tauri-apps/api/core";

/**
 * Thin wrapper around Tauri's invoke() — the only module allowed to call
 * invoke() directly. Everything else goes through installer.service.ts.
 */
export const tauriBridge = {
  hello: (name: string) => invoke<string>("hello", { name }),
  detectDotNet: () => invoke<boolean>("detect_dotnet"),
  runDotNet: (input: string) => invoke<string>("run_dotnet", { input }),
};
