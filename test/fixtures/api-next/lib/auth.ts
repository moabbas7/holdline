type Handler = (ctx: { req: Request; userId: string }) => Promise<Response>;

export function withAuth(handler: Handler) {
  return async (req: Request) => handler({ req, userId: 'u1' });
}
