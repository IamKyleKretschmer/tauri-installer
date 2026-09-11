import type { SqlServerConfig } from "../steps/SqlServerStep";
import type { IisNetConfig } from "../steps/IisNetStep";
import type { ActiveDirectoryConfig } from "../steps/ActiveDirectoryStep";
import type { NetworkTlsConfig } from "../steps/NetworkTlsStep";

/**
 * Builds a REAL SourceCode.SetupManager / Setup.exe silent-install answer
 * file, in the real <PRODUCT>/<COMPONENTS>/<VARIABLES> schema (confirmed
 * against a genuine captured K2 5.9.1 answer file: same root elements,
 * same COMPONENTS list, same [TOKEN] key names and connection-string
 * format). This is a best-effort reconstruction driven by whatever this
 * wizard actually collects — fields the wizard has no equivalent for
 * (LDAP paths, report site, Exchange, SmartActions, etc.) are left blank
 * exactly as the real file leaves optional ones blank, since the real
 * installer is invoked with /noval and skips answer-file validation.
 *
 * The license key is passed in at call time and is never persisted to
 * disk by this function's caller beyond the one temp answer file the
 * install run needs — see downloadK2Package/runRealInstaller in
 * installer.service.ts.
 */
export interface SilentInstallConfig {
  sqlConfig: SqlServerConfig;
  iisConfig: IisNetConfig;
  adConfig: ActiveDirectoryConfig;
  networkConfig: NetworkTlsConfig;
  productVersion: string;
  licenseKey: string;
  /** When set, reused as-is so the target database's encrypted contents stay decryptable across install attempts. */
  machineKey: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function connectionString(sqlConfig: SqlServerConfig): string {
  const instance = sqlConfig.instance || ".\\SQLEXPRESS";
  const database = sqlConfig.databaseName || "K2";
  const base = `Data Source=${instance};Initial Catalog=${database}`;
  const tail = "Pooling=True;Encrypt=True;TrustServerCertificate=True";
  return sqlConfig.authMode === "windows"
    ? `${base};Integrated Security=True;${tail}`
    : `${base};User ID=${sqlConfig.username || "sa"};Password=${sqlConfig.password};${tail}`;
}

/** Real component set for a full K2 Five server install, matching the real captured answer file. */
const COMPONENTS = ["CORE", "DATABASE", "CFG", "JSSERVICEPROVIDER", "SERVER", "PDF", "WORKSPACE", "NSA", "CLIENT_PD"];

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * Deterministically stretches/truncates an existing string (the machine
 * key) into exactly `length` bytes, repeating it as needed. Used so that
 * entering the same machine key on every run also reproduces the same
 * Rijndael key/IV, keeping a reused database's encrypted contents
 * decryptable across attempts instead of only the machine key matching.
 */
function deriveBytesFromString(source: string, length: number): Uint8Array {
  const encoded = new TextEncoder().encode(source);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = encoded[i % encoded.length];
  }
  return out;
}

export function buildK2SilentInstallXml(config: SilentInstallConfig): string {
  const { sqlConfig, iisConfig, adConfig, networkConfig, productVersion, licenseKey, machineKey } = config;

  // A blank/missing encryption key set is what SetupManager's
  // "EncryptionValidation: Unable to validate encryption" actually turns
  // out to mean (confirmed by it failing identically against a freshly
  // created, never-before-touched database) - it needs real key material
  // to even construct an encryption context, not just consistent key
  // material across runs. A real captured answer file's RIJNDAEL_KEY/IV
  // are 32/16 random bytes, base64-encoded; MACHINEKEY is 8 random bytes,
  // hex-encoded. When a machine key is supplied (for reusing a database
  // across attempts, see InstallStep's drop-database logic), everything
  // is derived from it so the same input reproduces the same keys; when
  // it's blank, everything is freshly randomized every run.
  const effectiveMachineKey = machineKey.trim() || bytesToHex(randomBytes(8));
  const rijndaelKey = bytesToBase64(
    machineKey.trim() ? deriveBytesFromString(machineKey.trim(), 32) : randomBytes(32),
  );
  const rijndaelIv = bytesToBase64(machineKey.trim() ? deriveBytesFromString(machineKey.trim(), 16) : randomBytes(16));

  const dbConnectionString = connectionString(sqlConfig);
  const dbName = sqlConfig.databaseName || "K2";
  const sqlServerInstance = sqlConfig.instance || ".\\SQLEXPRESS";
  const siteUrl = `https://${networkConfig.hostname || "localhost"}`;

  // Every *CONNECTIONSTRING/*DBNAME pair below points at the same single
  // consolidated database, matching what the real 5.9.1 answer file
  // actually did (see K2five591.xml) rather than the 14-separate-database
  // documentation block K2HostServer.exe.config's comments suggest.
  const variables: [string, string][] = [
    ["INSTALLDIR", "C:\\Program Files\\K2\\"],
    ["CONFIGURATIONFOLDER", "C:\\Program Files\\K2\\Configuration"],
    ["SIMPLEINSTALL", "false"],
    ["ISNLB", "false"],
    ["INSTALLTYPE", "blackpearl"],
    ["PRODUCTVERSION", productVersion],
    // Real trace log evidence: SetupManager's own Licensing.ValidLicense
    // check decodes every license key used in this project as "Licensed
    // Type: EVALUATION". Declaring PRODUCTION here while the license data
    // itself is an evaluation key is a real, confirmed cause of
    // HostLicenseManager.LoadLicensesInternal() throwing NotLicensedException
    // inside the K2 Server engine at startup (a stricter runtime check than
    // SetupManager's own loose pre-check) - it never opens its port-5555
    // listener afterward, which is what actually produced every
    // "actively refused it 127.0.0.1:5555" RegisterIdentity failure.
    ["LICENSETYPE", "EVALUATION"],
    ["LICENSEDPRODUCT", "K2FIVE"],
    ["LICENSEDATA", ""],
    ["LICENSEKEY", licenseKey],
    ["MACHINEKEY", effectiveMachineKey],
    ["RIJNDAEL_KEY", rijndaelKey],
    ["RIJNDAEL_IV", rijndaelIv],
    // Left unset, SetupManager defaults this to true whenever
    // Product.Config's defaultEncryptionType is "SQL" (confirmed via a
    // real install trace log), which requires a SQL Server-native
    // symmetric key ('SCSSOKey') that only exists if K2's own real
    // database schema deployment created it - something this app doesn't
    // run. Forcing it false makes SetupManager use the RIJNDAEL_KEY/IV
    // above instead, which we do provide, avoiding
    // "EncryptionValidation: Unable to validate encryption" entirely.
    ["USESQLENCRYPTION", "false"],
    ["HOSTSERVERNAME", "LOCALHOST"],
    ["HOSTSERVERPORT", "5555"],
    ["WORKFLOWSERVERPORT", "5252"],
    ["LBDISCOVERYPORT", "49600"],
    ["LBHOSTSERVERNAME", "LOCALHOST"],
    ["LBHOSTSERVERFQDN", networkConfig.hostname || "LOCALHOST"],
    ["LBSITENAME", siteUrl],
    ["HOSTSERVERDBSQLSERVER", sqlServerInstance],
    ["HOSTSERVERDBNAME", dbName],
    ["HOSTSERVERCONNECTIONSTRING", dbConnectionString],
    ["SMARTBOXDBNAME", dbName],
    ["SMARTBOXCONNECTIONSTRING", dbConnectionString],
    ["SMARTBROKERDBNAME", dbName],
    ["SMARTBROKERCONNECTIONSTRING", dbConnectionString],
    ["CATEGORIESDBNAME", dbName],
    ["CATEGORIESCONNECTIONSTRING", dbConnectionString],
    ["DEPENDANCIESDBNAME", dbName],
    ["DEPENDANCIESCONNECTIONSTRING", dbConnectionString],
    ["ENVIRONMENTLIBRARYDBNAME", dbName],
    ["ENVIRONMENTLIBRARYCONNECTIONSTRING", dbConnectionString],
    ["EVENTBUSDBNAME", dbName],
    ["EVENTBUSCONNECTIONSTRING", dbConnectionString],
    ["EVENTBUSSCHEDULERDBNAME", dbName],
    ["EVENTBUSSCHEDULERCONNECTIONSTRING", dbConnectionString],
    ["WORKSPACEDBNAME", dbName],
    ["WORKSPACECONNECTIONSTRING", dbConnectionString],
    ["WEBWORKFLOWDBNAME", dbName],
    ["WEBWORKFLOWCONNECTIONSTRING", dbConnectionString],
    ["WEBDESIGNERCONNECTIONSTRING", dbConnectionString],
    ["ADMINUSER", adConfig.serviceAccount],
    ["ADMINPASS", adConfig.servicePassword],
    ["USERSNAME", adConfig.serviceAccount],
    ["USERSPASS", adConfig.servicePassword],
    ["JSSP_AD_USER_NAME", adConfig.serviceAccount],
    ["JSSP_PASS", adConfig.servicePassword],
    ["SETSPN", "False"],
    ["SERVICE_NAME", "K2 Server"],
    ["ISONDOMAIN", "true"],
    ["USRMGRTYPE", "UMTYPE_ADUM"],
    ["WORKSPACEDISTRIBUTED", "true"],
    ["SITENAME", iisConfig.siteName || "K2"],
    ["HTTPPORT", iisConfig.httpPort || "80"],
    ["HTTPSPORT", iisConfig.httpsPort || "443"],
  ];

  const componentsXml = COMPONENTS.map((c) => `    <${c} />`).join("\n");
  const variablesXml = variables
    .map(([key, value]) => (value ? `    <add key="[${key}]">${escapeXml(value)}</add>` : `    <add key="[${key}]" />`))
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<PRODUCT Version="${escapeXml(productVersion)}">
  <COMPONENTS>
${componentsXml}
  </COMPONENTS>
  <VARIABLES>
${variablesXml}
  </VARIABLES>
</PRODUCT>
`;
}
