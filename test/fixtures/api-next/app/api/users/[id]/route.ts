import { NextResponse } from 'next/server';
import { findUser } from '@/lib/db';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await findUser(params.id);
  if (!user) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({
    user: { id: user.id, name: user.name, address: { city: user.city, zip: user.zip } },
    tags: ['a', 'b'],
  });
}

export async function DELETE() {
  return new Response(null, { status: 204 });
}
