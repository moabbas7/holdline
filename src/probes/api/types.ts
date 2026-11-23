/** Bumped whenever analysis output changes, so cached results are recomputed. */
export const API_ANALYSER_VERSION = 1;
export const API_CAPTURE_VERSION = 1;

/**
 * The JSON shape of a value: types only, never values. Unions are normalised so they hold at
 * most one object and one array member (fields present in only some members are optional).
 */
export type Shape =
  | { k: 'string' }
  | { k: 'number' }
  | { k: 'boolean' }
  | { k: 'null' }
  | { k: 'object'; fields: Record<string, Field>; open?: true; values?: Shape }
  | { k: 'array'; of: Shape }
  | { k: 'union'; of: Shape[] }
  | { k: 'unknown'; why?: string };

export interface Field {
  shape: Shape;
  /** 'unknown' when only the name is known (an untyped destructured body field). */
  optional: boolean | 'unknown';
}

export type Status = number | 'unknown';

/** All responses of one status code, merged. `body` null: no JSON body (redirect, text, empty). */
export interface StatusResponse {
  status: Status;
  body: Shape | null;
  /** Where it is returned: "file:line" (first few). */
  at: string[];
}

export interface RequestShape {
  /** JSON body read by the handler, when it reads one. */
  body?: Shape;
  query: string[];
  params: string[];
}

export interface MethodApi {
  responses: StatusResponse[];
  /** False when some response could not be analysed (unknown status or response expression). */
  complete: boolean;
  /** The handler (or a helper) throws: error responses produced elsewhere are not listed. */
  throws?: true;
  /** Set when the method's handler couldn't be analysed (its responses are unknown). */
  unknown?: string;
  request: RequestShape;
}

export interface RouteApi {
  pattern: string;
  files: string[];
  /** Method → API. '*' = every method (no method branches found). */
  methods: Record<string, MethodApi>;
  /** Set when the route's handler couldn't be analysed at all. */
  unknown?: string;
}

export interface LiveRequestResult {
  method: string;
  /** Path as configured, with query values redacted. */
  path: string;
  status?: number;
  contentType?: string;
  /** JSON shape of the response (types only), null when the body is not JSON. */
  shape?: Shape | null;
  ms?: number;
  error?: 'timeout' | 'connection' | 'invalid-json' | 'skipped';
  /** Why a request was skipped (configuration problem). Never contains values. */
  note?: string;
}

export interface LiveCapture {
  status: 'off' | 'ok' | 'refused' | 'failed';
  message?: string;
  results: LiveRequestResult[];
  ms?: number;
}

export interface ApiStats {
  routes: number;
  analysed: number;
  unknown: number;
  cached: number;
  mode: 'typed' | 'syntax' | 'mixed' | 'none';
  ms: number;
}

export interface ApiCapture {
  version: number;
  routes: Record<string, RouteApi>;
  live: LiveCapture;
  warnings: string[];
  stats: ApiStats;
}

/** What the probe stores in session.json. */
export interface ApiRef {
  file: string;
  sha256: string;
  routes: number;
  live: LiveCapture['status'];
}

export interface LiveRequestConfig {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface LiveSettings {
  enabled: boolean;
  command?: string;
  startupTimeoutSec: number;
  requestTimeoutSec: number;
  allowNonLocalDatabase: boolean;
  headers: Record<string, string>;
  requests: LiveRequestConfig[];
}

export interface ApiSettings {
  timeoutSec: number;
  live: LiveSettings;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d);
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
};

export function apiSettings(raw: Record<string, unknown> | undefined): ApiSettings {
  const live = (raw?.live && typeof raw.live === 'object' ? raw.live : {}) as Record<string, unknown>;
  const requests = Array.isArray(live.requests)
    ? (live.requests as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { path?: unknown }).path === 'string')
        .map((r) => ({
          path: r.path as string,
          ...(typeof r.method === 'string' ? { method: r.method } : {}),
          ...('body' in r ? { body: r.body } : {}),
          ...(r.headers ? { headers: strMap(r.headers) } : {}),
        }))
    : [];
  return {
    timeoutSec: num(raw?.timeoutSec, 60),
    live: {
      enabled: live.enabled === true,
      ...(typeof live.command === 'string' ? { command: live.command } : {}),
      startupTimeoutSec: num(live.startupTimeoutSec, 90),
      requestTimeoutSec: num(live.requestTimeoutSec, 60),
      allowNonLocalDatabase: live.allowNonLocalDatabase === true,
      headers: strMap(live.headers),
      requests,
    },
  };
}
