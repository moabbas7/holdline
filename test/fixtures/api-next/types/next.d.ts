// Minimal stand-ins for next's types, so the fixture needs no install.
declare module 'next/server' {
  export class NextResponse<Body = unknown> extends Response {
    static json<JsonBody>(body: JsonBody, init?: ResponseInit): NextResponse<JsonBody>;
    static redirect(url: string | URL, init?: number | ResponseInit): NextResponse;
    static next(): NextResponse;
  }
  export type NextRequest = Request & { nextUrl: URL };
}
declare module 'next' {
  export interface NextApiRequest {
    method?: string;
    query: Record<string, string | string[] | undefined>;
    body: any;
  }
  export interface NextApiResponse<Data = any> {
    status(code: number): NextApiResponse<Data>;
    json(body: Data): void;
    send(body: Data): void;
    end(): void;
    setHeader(name: string, value: string): NextApiResponse<Data>;
  }
}
