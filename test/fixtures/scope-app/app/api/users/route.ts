import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const { data } = await db.from('users').select('id, first, last');
  return NextResponse.json(data ?? []);
}
