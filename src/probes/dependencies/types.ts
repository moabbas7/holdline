/** Bumped whenever extraction output changes, so cached facts are re-parsed. */
export const EXTRACTOR_VERSION = 3;

export type ImportKind = 'import' | 'reexport' | 'require' | 'dynamic';

export interface ImportFact {
  spec: string;
  /** Imported names: 'default', '*' (namespace / export *), or a named export. Empty for side-effect imports. */
  names: string[];
  /** [local name, imported name] pairs for bindings created in this file. */
  bindings: [string, string][];
  kind: ImportKind;
  typeOnly: boolean;
  line: number;
}

/** `<receiver>.<method>('/literal', …)`: either an HTTP client call or a server route definition. */
export interface MethodCallFact {
  receiver: string;
  method: string;
  url: string;
  argc: number;
  /** A later argument is a function, identifier or call (a handler), not an options object. */
  hasHandlerArg: boolean;
  /** The literal started with '/' (route definitions always do). */
  pathLike: boolean;
  line: number;
}

export interface HttpCallFact {
  client: 'fetch' | 'axios' | 'swr';
  method?: string;
  url: string;
  line: number;
}

export interface MountFact {
  receiver: string;
  prefix: string;
  /** Local identifier that was mounted, or the spec of an inline require(). */
  local?: string;
  spec?: string;
  line: number;
}

export interface TableFact {
  name: string;
  via: 'supabase' | 'sql';
  line: number;
}

export interface FileFacts {
  imports: ImportFact[];
  /** Names this file exports, including 'default'. */
  exports: string[];
  /** Specs of `export * from '…'`. */
  starExports: string[];
  /** Export name → local identifier, when they differ or for `export default ident`. */
  exportLocals: Record<string, string>;
  /** Uses module.exports / exports.x / `export =`. */
  hasCjs: boolean;
  /** First statement is 'use server'. */
  useServer: boolean;
  /** Imports express, fastify, hono, koa router or similar. */
  serverFramework: boolean;
  httpCalls: HttpCallFact[];
  methodCalls: MethodCallFact[];
  /** axios.create() instances: local name → baseURL (or '' if none/dynamic). */
  axiosInstances: Record<string, string>;
  mounts: MountFact[];
  tables: TableFact[];
  /** Drizzle table definitions: local const name → table. */
  drizzleDefs: Record<string, string>;
  /** Identifiers passed to drizzle query builders (.from(x), .insert(x), …). */
  drizzleRefs: { local: string; line: number }[];
  /** db.query.<name>.findMany(): schema keys. */
  drizzleQueryRefs: { name: string; line: number }[];
  /** `<receiver>.<model>.<prismaMethod>()` candidates. */
  prismaCalls: { receiver: string; model: string; line: number }[];
  /** Tables created/altered/dropped by DDL (.sql files). */
  ddlTables: string[];
  /** Prisma models (schema.prisma): model → table name. */
  prismaModels: Record<string, string>;
}

export function emptyFacts(): FileFacts {
  return {
    imports: [],
    exports: [],
    starExports: [],
    exportLocals: {},
    hasCjs: false,
    useServer: false,
    serverFramework: false,
    httpCalls: [],
    methodCalls: [],
    axiosInstances: {},
    mounts: [],
    tables: [],
    drizzleDefs: {},
    drizzleRefs: [],
    drizzleQueryRefs: [],
    prismaCalls: [],
    ddlTables: [],
    prismaModels: {},
  };
}

export type FileRole = 'page' | 'api-route' | 'server-action' | 'schema' | 'module';

export type EdgeType =
  | 'import'
  | 'server-action'
  | 'calls-api'
  | 'handles-route'
  | 'uses-table'
  | 'defines-table';

/** `from` depends on `to`. Node ids: a file path, `route:<pattern>` or `table:<name>`. */
export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
  line?: number;
  /**
   * import / server-action edges: names `from` imports from `to` for its own use ('*' for a
   * namespace import; empty for require, dynamic and side-effect imports, which may use anything).
   */
  names?: string[];
  /** Names `from` re-exports from `to` ('*' for `export * from`). Set only on re-exports. */
  reexports?: string[];
}

export interface BrokenImport {
  file: string;
  spec: string;
  line: number;
  reason: 'missing-file' | 'missing-export';
  name?: string;
  /** For missing-export: the file the import resolved to. */
  target?: string;
}

export interface GraphStats {
  files: number;
  edges: number;
  routes: number;
  tables: number;
  broken: number;
  parsed: number;
  cached: number;
  ms: number;
}

/** Where a route is handled: a Next.js route file, a pages/api file, or a server route definition. */
export interface RouteHandler {
  file: string;
  kind: 'next-app' | 'next-pages' | 'server';
  /** For 'server': the HTTP method of the definition ('*' for app.all) and its line. */
  method?: string;
  line?: number;
}

/** An HTTP call to one of this project's URLs, with the routes it matched (empty when none). */
export interface ApiCall {
  file: string;
  url: string;
  /** Upper-case method when known (fetch without options is GET). */
  method?: string;
  line: number;
  routes: string[];
}

export interface DepGraph {
  version: 1;
  /** `exports`: the names a source file exports (absent in graphs from older versions). */
  files: Record<string, { hash: string; role: FileRole; exports?: string[] }>;
  routes: Record<string, { files: string[]; methods: string[]; handlers?: RouteHandler[] }>;
  tables: Record<string, { definedIn: string[] }>;
  edges: Edge[];
  broken: BrokenImport[];
  unmatchedCalls: { file: string; url: string; line: number }[];
  /** Every call to a project URL (graphs written before phase 4 lack it). */
  apiCalls?: ApiCall[];
  stats: GraphStats;
}

/** What the probe stores in session.json: a pointer to the graph file. */
export interface DepGraphRef {
  file: string;
  sha256: string;
  stats: GraphStats;
}

export const routeId = (pattern: string) => `route:${pattern}`;
export const tableId = (name: string) => `table:${name}`;
