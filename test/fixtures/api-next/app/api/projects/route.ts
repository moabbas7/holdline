import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';

export const GET = withAuth(async ({ userId }) => {
  return NextResponse.json({ projects: [{ id: 'p1', name: 'One', ownerId: userId }], count: 1 });
});
