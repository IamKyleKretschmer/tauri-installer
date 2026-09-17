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
  /**
   * This machine's real short computer name (e.g. "SAF-K2TEST2153"), from
   * get_computer_name - NOT networkConfig.hostname, which is the K2 site's
   * public URL/FQDN (defaults to "portal.<domain>") and has no relation to
   * the actual machine identity the K2 Server engine looks itself up by.
   * Falls back to "LOCALHOST" only if the real name couldn't be read.
   */
  computerName: string;
  /**
   * Real answer-file/runtime token, confirmed from trace-log conditions
   * like "!Exists:[...] | [EXECUTION_TYPE]=Repair" gating whether targets
   * re-copy files or re-run config that a prior run already did. Left
   * undefined (the default), it's absent from VARIABLES entirely, which is
   * what every fresh-install run so far has done. Set to "Update" for a
   * maintenance run against an already-installed K2, so the vendor
   * package's own targets skip work they detect is already done instead of
   * replaying the full first-install sequence.
   */
  executionType?: "Update";
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
  const { sqlConfig, iisConfig, adConfig, networkConfig, productVersion, licenseKey, machineKey, computerName, executionType } =
    config;

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
  // Real trace log evidence: a hostname entered with a trailing slash (e.g.
  // "nintex.k2test.net/") propagates into every URL token derived from it
  // here (LBHOSTSERVERFQDN, LBSITENAME, K2SITEURL(_SSL), PRIMARY_WORKSPACE),
  // then into K2's own claims config script, which builds a lookup URL by
  // concatenating another path onto [K2SITEURL_SSL] - producing a double
  // slash ("nintex.k2test.net//Identity/...") that no longer matches the
  // single-slash URL the ClaimIssuer row was actually inserted under. The
  // resulting 0-row lookup defaults IssuerID to '0', which then fails
  // FK_Identity_ClaimRealmIssuer_Identity_ClaimIssuer - a single stray
  // trailing slash cascading into a deep, unrelated-looking SQL error.
  // Strip any trailing slashes (and an accidentally pasted scheme) here so
  // every derived token stays consistent regardless of what was typed.
  const cleanHostname = (networkConfig.hostname || "localhost").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const siteUrl = `https://${cleanHostname}`;
  const siteHost = cleanHostname;
  const httpPortValue = iisConfig.httpPort || "80";
  const httpsPortValue = iisConfig.httpsPort || "443";
  const httpSiteUrl = `http://${siteHost}${httpPortValue === "80" ? "" : `:${httpPortValue}`}`;
  const httpsSiteUrl = `https://${siteHost}${httpsPortValue === "443" ? "" : `:${httpsPortValue}`}`;

  // Real evidence (K2 Server engine's own HostServer log + decompiled
  // HostLicenseManager.LoadLicensesInternal()): the license row this app
  // writes to [LicenseKeys] is looked up at runtime with
  // "WHERE [HostName] = @HostName" using the engine's own resolved local
  // computer name (confirmed via a real trace log's own environment-setup
  // line: "[HOST] = SAF-K2TEST2153") - NOT the literal string "LOCALHOST",
  // and NOT networkConfig.hostname either (that's the K2 site's public
  // URL/FQDN, e.g. "portal.k2test.com" - a different, unrelated value
  // that has no relation to the machine's actual identity; deriving from
  // it produced "PORTAL", which was just as wrong as "LOCALHOST"). Any
  // mismatch here means that WHERE clause matches zero rows, so the
  // loader never even reaches K2LicenseValidator and throws
  // NotLicensedException - which then blocks the K2 Server engine's own
  // port-5555 listener from ever opening, cascading into every
  // RegisterIdentity "actively refused" failure seen after RegisterShard
  // started succeeding.
  const shortHostname = computerName.trim() || "LOCALHOST";

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
    // Real trace log evidence: without this token, K2HostServer.exe.Config
    // is written with the literal, unsubstituted placeholder text
    // "[SMARTACTIONSENABLED]" in its enableListeners attribute (line 480),
    // which .NET's config parser can't parse as a Boolean -
    // MessageBusService.Init throws ConfigurationErrorsException on every
    // K2 Server startup, one of two crashes (alongside the missing default
    // Security Label) that were the real cause behind every RegisterIdentity
    // "actively refused" failure - the engine never got far enough to open
    // its port-5555 listener at all. This app doesn't configure SmartActions,
    // so false.
    ["SMARTACTIONSENABLED", "false"],
    // Real trace log evidence (the actual root cause of "Default Security
    // Label not found" -> HostServerEngine.StartHostServer() crash -> every
    // RegisterIdentity "actively refused"): SetupManager's own
    // EnsureSecurityLabel targets for both the "K2" and "K2SQL" security
    // labels compute DefaultLabel dynamically as Equals([INST_Label];;<name>).
    // Without this token, [INST_Label] is echoed back completely
    // unresolved (SmartVariables literally returns the string
    // "[INST_Label]"), so neither comparison is ever true and NO security
    // label ever gets marked default - HostLicenseManager/HostSecurityManager
    // then find zero rows via [HostServer].[GetDefaultSecurityLabelName]
    // and the engine crashes on startup before ever opening its port-5555
    // listener, regardless of the licensing/hostname fixes (those were real
    // and necessary, just not sufficient on their own). "K2" is the correct
    // default here since this is a domain-joined install (the "K2" label's
    // AuthInit uses the real AD domain; "K2SQL" is only used internally for
    // system/service connections, per the K2HOSTCONNECTIONSTRING_SYSTEM
    // connection strings seen throughout every trace log).
    ["INST_Label", "K2"],
    // Real root cause of the Management.kspx "Primary Credentials Not
    // Authenticated. Session Not Authenticated." failure that blocked every
    // install after the fixes above got the engine running: confirmed via
    // K2HostServer.exe.config on the actual machine that its <connectionStrings>
    // "HostServer" entry held the literal, unresolved text
    // "[K2HOSTCONNECTIONSTRING]" instead of a real connection string. This
    // token is only ever set by SetupManager's own UserPanel.FinishPanel()
    // UI code (decompiled source confirmed) - a wizard panel that never runs
    // during a silent, answer-file-driven install - so it was never defined
    // and got written into the config file as raw, useless text. Every
    // server-internal loopback call that reads this config entry (e.g.
    // DeploymentServer.GetCategoriesAndDataWithoutRights, called during
    // Management.kspx deployment) then opens a connection to nowhere,
    // producing an unauthenticated session and this exact error - completely
    // unrelated to the System/K2SQL account or its password, which were
    // always correct. Values mirror UserPanel's own non-SQLUM (AD-joined)
    // branch, matching INST_Label=K2 above.
    ["K2HOSTCONNECTIONSTRING", "Integrated=True;IsPrimaryLogin=True;Authenticate=True;EncryptedPassword=False;Host=[LBHOSTSERVERNAME];Port=[HOSTSERVERPORT]"],
    ["K2WFCONNECTIONSTRING", "Integrated=True;IsPrimaryLogin=True;Authenticate=True;EncryptedPassword=False;Host=[LBHOSTSERVERNAME];Port=[WORKFLOWSERVERPORT]"],
    ["HOSTSERVERNAME", shortHostname],
    ["HOSTSERVERPORT", "5555"],
    ["WORKFLOWSERVERPORT", "5252"],
    ["LBDISCOVERYPORT", "49600"],
    ["LBHOSTSERVERNAME", shortHostname],
    ["LBHOSTSERVERFQDN", cleanHostname || "LOCALHOST"],
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
    // Same class of bug as K2HOSTCONNECTIONSTRING, confirmed via real trace
    // log evidence (InstallerTrace260914_3): [WORKSUSER] is only ever set by
    // SetupManager's own UserPanel.FinishPanel() UI code ("if WORKSUSER is
    // empty, set it to the admin/service account") - a wizard panel that
    // never runs during a silent install - so it was left as the literal,
    // unresolved token text and got substituted straight into raw T-SQL:
    // CreateSqlLogin/CreateSqlUser/AssignSqlUserRole all failed with
    // "Unclosed quotation mark after the character string '[WORKSUSER] ...'"
    // since the brackets themselves ended up inside the generated SQL. That
    // cascaded into every downstream step depending on that SQL login
    // existing (CreateWebApplication/AssociateAppPoolToWebApp for SP15_WEB,
    // several K2 Site/K2 Designer permission and redirect targets, and
    // ultimately the whole "K2 Site" component failing) - all before this
    // fix, this specific missing token was the real root cause, not IIS or
    // the app pool itself.
    ["WORKSUSER", adConfig.serviceAccount],
    ["WORKSPASS", adConfig.servicePassword],
    ["JSSP_AD_USER_NAME", adConfig.serviceAccount],
    ["JSSP_PASS", adConfig.servicePassword],
    ["SETSPN", "False"],
    ["SERVICE_NAME", "K2 Server"],
    ["ISONDOMAIN", "true"],
    ["USRMGRTYPE", "UMTYPE_ADUM"],
    ["WORKSPACEDISTRIBUTED", "true"],
    ["SITENAME", iisConfig.siteName || "K2"],
    // Real trace log evidence: "K2 Workspace - Create K2 Workspace Site" and
    // its follow-on "K2 Workspace - Ensure Certificate for SSL Binding"
    // target reference Name="[K2SITENAME]"/CertificateName="[K2SITENAME]".
    // Left undefined, SmartVariables echoes the raw "[K2SITENAME]" text back
    // as the "resolved" value, so the Workspace site actually gets created
    // under that literal bracketed name rather than the real site - then
    // EnsureCertificate's GetCertificateHash call against that broken site
    // throws ArgumentNullException (BitConverter.ToString on a null hash),
    // leaving the Workspace site's SSL binding/cert half-configured. Set to
    // the same value as SITENAME so Workspace lands on the one real site
    // this box's Designer/Runtime/Management already deploy to.
    ["K2SITENAME", iisConfig.siteName || "K2"],
    ["HTTPPORT", iisConfig.httpPort || "80"],
    ["HTTPSPORT", iisConfig.httpsPort || "443"],
    // Same class of bug as WORKSUSER/K2HOSTCONNECTIONSTRING above: the
    // vendor package's CreateAppPool targets ("K2 Workspace - Create K2
    // Workspace App Pool" / "...Create K2 Workspace .NET 4 App Pool")
    // reference AppPoolName="[K2APPPOOL]" / "[K2APPPOOL_NET4]" and gate on
    // Condition="![AppPoolExists([K2APPPOOL])]" etc. Without these tokens
    // defined here, SetupManager substitutes nothing and passes the raw,
    // unresolved "[K2APPPOOL]" text straight into AppPool.Add/AppPoolExists
    // - the actual cause of the app pool creation failure, not IIS itself.
    ["K2APPPOOL", `${iisConfig.siteName || "K2"} AppPool`],
    ["K2APPPOOL_NET4", `${iisConfig.siteName || "K2"} AppPool - .NET 4`],
    // Real trace log evidence: DoClaimsConfig.EnsureIdVars logs "Variable
    // [K2SITEURL_SSL] not populated, moving on" / same for [K2SITEURL]
    // right at startup when these are undefined, which skips setting up
    // the claims identity/realm rows it normally would - the actual root
    // cause of a later "INSERT ... conflicted with the FOREIGN KEY
    // constraint FK_Identity_ClaimRealmIssuer_Identity_ClaimIssuer" failure
    // deep in K2 Site component setup. [K2SFSITEURL]/[K2SFSITEURL_SSL]
    // (SharePoint farm-facing site URL) are referenced the same way further
    // into K2 Site setup; for this single-box install, the same host serves
    // both roles.
    ["K2SITEURL", httpSiteUrl],
    ["K2SITEURL_SSL", httpsSiteUrl],
    ["K2SFSITEURL", httpSiteUrl],
    ["K2SFSITEURL_SSL", httpsSiteUrl],
    // Confirmed against a genuine captured K2 answer file: [PRIMARY_WORKSPACE]
    // is NOT derived from K2SITEURL_SSL - it's its own plain token, set
    // directly to the site's HTTPS URL (identical to LBSITENAME/K2SITEURL_SSL
    // in the real capture), same as [PRIMARY_WORKSPACE_HOST]/[..._SCHEME].
    // Left undefined, it stays literal "[PRIMARY_WORKSPACE]" text, which is
    // what actually threw "This is an unclosed string" once that raw bracket
    // text got substituted into an XPath string literal for a Web.config
    // patch (system.serviceModel/.../add[@baseAddress='[PRIMARY_WORKSPACE]/...']).
    // The WS_/RT_/DE_ *_FIELDNAME tokens are fixed Environment Library field
    // labels (not site-specific) that the same "Update Environment Library"
    // targets need for Designer/Runtime, matching the real capture verbatim -
    // included now to avoid hitting this identical bug on those next.
    ["PRIMARY_WORKSPACE", httpsSiteUrl],
    ["PRIMARY_WORKSPACE_HOST", siteHost],
    ["PRIMARY_WORKSPACE_SCHEME", "https"],
    ["WS_FIELDNAME", "Web Service URL"],
    ["RT_FIELDNAME", "SmartForms Runtime"],
    ["DE_FIELDNAME", "SmartForms Designer"],
    ["WS_FIELDNAME_SSL", "Web Service URL SSL"],
    ["RT_FIELDNAME_SSL", "SmartForms Runtime SSL"],
    ["DE_FIELDNAME_SSL", "SmartForms Designer SSL"],
    ["DE_FIELDNAME_RUNTIME", "SmartForms Designer Runtime"],
    // Real evidence: the vendor's own ClaimsConfig.cs doc comment shows the
    // exact XML this feeds - <ClaimIssuer Name="K2 Windows STS"
    // Issuer="WindowsSTS" ThumbPrint="[SP_CERT_THUMBPRINT_WS]" .../> - and
    // the genuine captured answer file sets this to a real cert thumbprint.
    // Left undefined here, the target that creates the base K2 Windows/Forms
    // STS ClaimIssuer rows never ran at all in a real trace (zero
    // ClaimIssuer INSERTs anywhere in the whole run) - the actual root
    // cause of a later "INSERT ... conflicted with the FOREIGN KEY
    // constraint FK_Identity_ClaimRealmIssuer_Identity_ClaimIssuer" failure,
    // not a database or vendor bug. Reuse the SSL certificate thumbprint
    // already selected on the IIS & .NET step rather than asking for a
    // second one - it's the same real cert being bound to this site.
    ["SP_CERT_THUMBPRINT_WS", iisConfig.sslCertificate || ""],
    ...(executionType ? ([["EXECUTION_TYPE", executionType]] as [string, string][]) : []),
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
