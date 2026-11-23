import { NextResponse } from 'next/server';
import { getUsers } from '@/lib/db';
import { createUserSchema } from '@/lib/schema';
import type { User } from '@/lib/types';

export async function GET(req: Request) {
  const page = new URL(req.url).searchParams.get('page');
  const users: User[] = await getUsers();
  return NextResponse.json({ users, total: users.length, page });
}

export async function POST(req: Request) {
  const body = await req.json();
  const input = createUserSchema.parse(body);
  return NextResponse.json({ id: 1, name: input.name }, { status: 201 });
}
