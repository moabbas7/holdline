// Plain JavaScript, no types: shapes come from the object literal.
export async function GET() {
  return Response.json({ count: 3, items: [{ id: 1, label: 'x' }], ok: true });
}
