/**
 * K2's real component/category model, reverse engineered from
 * SourceCode.Install.Package.dll (SourceCode.Install.Package.Components
 * namespace: Component, ComponentCategory, ComponentAction, SetupTypes,
 * ComponentDependency). ComponentCategory is Core | Server | Web | Client,
 * which is exactly the four section headers on the legacy Components
 * screen (Required/Server/Web/Client Components), and a component can
 * have a Parent whose ChildComponents nest under it, e.g. K2 Database ->
 * K2 Configuration Service -> K2 JavaScript Service Provider.
 *
 * The actual per-target IInstallAction implementations (what a target
 * literally executes, e.g. the "SourceCode.Data.Authorization.inject.sql"
 * line shown during a real install) live in assemblies this spike doesn't
 * have, so the target labels below are illustrative rather than the
 * verbatim legacy install script names.
 */

export type ComponentCategory = "Required Components" | "Server Components" | "Web Components" | "Client Components";

export interface K2Component {
  id: string;
  displayName: string;
  category: ComponentCategory;
  /** Component id this one depends on/nests under, matching Component.Parent. */
  parentId?: string;
  /** Illustrative per-target install steps, shown as the current-task line during Install. */
  targets: string[];
}

export const K2_COMPONENTS: K2Component[] = [
  {
    id: "k2-core",
    displayName: "K2 Core",
    category: "Required Components",
    targets: ["Validating license", "Registering K2 core services"],
  },
  {
    id: "k2-database",
    displayName: "K2 Database",
    category: "Server Components",
    targets: ["Creating K2 database", "Applying schema and seed data"],
  },
  {
    id: "k2-config-service",
    displayName: "K2 Configuration Service",
    category: "Server Components",
    parentId: "k2-database",
    targets: ["Installing K2 Configuration Service"],
  },
  {
    id: "k2-js-service-provider",
    displayName: "K2 JavaScript Service Provider",
    category: "Server Components",
    parentId: "k2-config-service",
    targets: ["Registering JavaScript Service Provider"],
  },
  {
    id: "k2-server",
    displayName: "K2 Server",
    category: "Server Components",
    targets: ["Installing K2 Server Windows service", "Starting K2 Server"],
  },
  {
    id: "k2-pdf-converter",
    displayName: "K2 PDF Converter Service",
    category: "Server Components",
    parentId: "k2-server",
    targets: ["Installing K2 PDF Converter Service"],
  },
  {
    id: "k2-site",
    displayName: "K2 Site",
    category: "Web Components",
    targets: ["Creating IIS site", "Configuring application pool"],
  },
  {
    id: "nwc-smartobject-api",
    displayName: "NWC SmartObject API",
    category: "Web Components",
    parentId: "k2-site",
    targets: ["Deploying NWC SmartObject API"],
  },
  {
    id: "k2-package-deployment",
    displayName: "K2 Package and Deployment",
    category: "Client Components",
    targets: ["Installing K2 Package and Deployment client tools"],
  },
];

export const COMPONENT_CATEGORIES: ComponentCategory[] = [
  "Required Components",
  "Server Components",
  "Web Components",
  "Client Components",
];

export function childrenOf(id: string): K2Component[] {
  return K2_COMPONENTS.filter((c) => c.parentId === id);
}

/**
 * Execution/render order: category order as in COMPONENT_CATEGORIES,
 * and within a category, parents always before their children (depth
 * first), matching Component.Execute() only running once
 * DependenciesMet (its parent already installed).
 */
export function executionOrder(): K2Component[] {
  const ordered: K2Component[] = [];
  const visit = (component: K2Component) => {
    ordered.push(component);
    for (const child of childrenOf(component.id)) {
      visit(child);
    }
  };
  for (const category of COMPONENT_CATEGORIES) {
    for (const component of K2_COMPONENTS.filter((c) => c.category === category && !c.parentId)) {
      visit(component);
    }
  }
  return ordered;
}
