import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

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

export interface CertificateInfo {
  thumbprint: string;
  subject: string;
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
  testSqlConnection: (params: {
    instance: string;
    authMode: string;
    username: string;
    password: string;
    database: string;
  }) =>
    invoke<string>("test_sql_connection", {
      instance: params.instance,
      authMode: params.authMode,
      username: params.username,
      password: params.password,
      database: params.database,
    }),
  checkTls12: () => invoke<CheckResult>("check_tls12"),
  checkTlsLegacy: () => invoke<CheckResult>("check_tls_legacy"),
  checkIpv4: () => invoke<CheckResult>("check_ipv4"),
  checkPort: (port: number) => invoke<CheckResult>("check_port", { port }),
  listCertificates: () => invoke<CertificateInfo[]>("list_certificates"),
  getMachineFqdn: () => invoke<string | null>("get_machine_fqdn"),
  checkAdObjects: (params: { serviceAccount: string; adminsGroup: string; createGroupIfMissing: boolean }) =>
    invoke<string>("check_ad_objects", {
      serviceAccount: params.serviceAccount,
      adminsGroup: params.adminsGroup,
      createGroupIfMissing: params.createGroupIfMissing,
    }),
  configureIisSite: (params: {
    siteName: string;
    httpPort: string;
    httpsPort: string;
    appPoolIdentity: string;
    certificateThumbprint: string;
  }) =>
    invoke<string>("configure_iis_site", {
      siteName: params.siteName,
      httpPort: params.httpPort,
      httpsPort: params.httpsPort,
      appPoolIdentity: params.appPoolIdentity,
      certificateThumbprint: params.certificateThumbprint,
    }),
  copyK2Files: (sourceRoot: string) => invoke<string>("copy_k2_files", { sourceRoot }),
  disableLegacyTls: () => invoke<string>("disable_legacy_tls"),
  grantServiceLogonRight: (account: string) => invoke<string>("grant_service_logon_right", { account }),
  writeInstallLog: (contents: string) => invoke<string>("write_install_log", { contents }),
  openUrl: (url: string) => openUrl(url),
  openPath: (path: string) => openPath(path),
  closeWindow: () => getCurrentWindow().close(),
  getLaunchArgs: () => invoke<{ output: string | null; install: string | null }>("get_launch_args"),
  writeTextFile: (path: string, contents: string) => invoke<string>("write_text_file", { path, contents }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
};
