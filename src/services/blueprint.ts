import type { SqlServerConfig } from "../steps/SqlServerStep";
import type { IisNetConfig } from "../steps/IisNetStep";
import type { ActiveDirectoryConfig } from "../steps/ActiveDirectoryStep";
import type { NetworkTlsConfig } from "../steps/NetworkTlsStep";

/**
 * A simplified version of the legacy installer's answer-file idea
 * (setupmanager.exe /output:bp.xml writes one, setup.exe /install:bp.xml
 * installs from one, no interactive wizard). The real installer's own
 * blueprint format is a giant flat <VARIABLES> key/value dump; this is a
 * small, purpose-built schema covering exactly the four config sections
 * this wizard collects.
 */
export interface Blueprint {
  sqlConfig: SqlServerConfig;
  iisConfig: IisNetConfig;
  adConfig: ActiveDirectoryConfig;
  networkConfig: NetworkTlsConfig;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildBlueprintXml(blueprint: Blueprint): string {
  const { sqlConfig, iisConfig, adConfig, networkConfig } = blueprint;
  return `<?xml version="1.0" encoding="utf-8"?>
<K2Blueprint version="1">
  <SqlServer
    instanceSource="${escapeXml(sqlConfig.instanceSource)}"
    instance="${escapeXml(sqlConfig.instance)}"
    authMode="${escapeXml(sqlConfig.authMode)}"
    username="${escapeXml(sqlConfig.username)}"
    password="${escapeXml(sqlConfig.password)}"
    databaseName="${escapeXml(sqlConfig.databaseName)}"
  />
  <Iis
    siteName="${escapeXml(iisConfig.siteName)}"
    httpPort="${escapeXml(iisConfig.httpPort)}"
    httpsPort="${escapeXml(iisConfig.httpsPort)}"
    appPoolIdentity="${escapeXml(iisConfig.appPoolIdentity)}"
    sslCertificate="${escapeXml(iisConfig.sslCertificate)}"
  />
  <ActiveDirectory
    serviceAccount="${escapeXml(adConfig.serviceAccount)}"
    servicePassword="${escapeXml(adConfig.servicePassword)}"
    adminsGroup="${escapeXml(adConfig.adminsGroup)}"
    createGroupIfMissing="${adConfig.createGroupIfMissing ? "true" : "false"}"
  />
  <Network
    hostname="${escapeXml(networkConfig.hostname)}"
  />
</K2Blueprint>
`;
}

export function parseBlueprintXml(xml: string): Blueprint {
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error("The blueprint file is not valid XML.");
  }

  function attr(selector: string, name: string, fallback = ""): string {
    return doc.querySelector(selector)?.getAttribute(name) ?? fallback;
  }

  const root = doc.querySelector("K2Blueprint");
  if (!root) {
    throw new Error("The blueprint file is missing its <K2Blueprint> root element.");
  }

  const instanceSource = attr("SqlServer", "instanceSource", "existing");
  const authMode = attr("SqlServer", "authMode", "sql");

  return {
    sqlConfig: {
      instanceSource: instanceSource === "new" ? "new" : "existing",
      instance: attr("SqlServer", "instance"),
      authMode: authMode === "windows" ? "windows" : "sql",
      username: attr("SqlServer", "username"),
      password: attr("SqlServer", "password"),
      databaseName: attr("SqlServer", "databaseName", "K2"),
    },
    iisConfig: {
      siteName: attr("Iis", "siteName", "K2"),
      httpPort: attr("Iis", "httpPort", "80"),
      httpsPort: attr("Iis", "httpsPort", "443"),
      appPoolIdentity: attr("Iis", "appPoolIdentity", "NetworkService"),
      sslCertificate: attr("Iis", "sslCertificate"),
    },
    adConfig: {
      serviceAccount: attr("ActiveDirectory", "serviceAccount"),
      servicePassword: attr("ActiveDirectory", "servicePassword"),
      adminsGroup: attr("ActiveDirectory", "adminsGroup"),
      createGroupIfMissing: attr("ActiveDirectory", "createGroupIfMissing", "false") === "true",
    },
    networkConfig: {
      hostname: attr("Network", "hostname"),
    },
  };
}
