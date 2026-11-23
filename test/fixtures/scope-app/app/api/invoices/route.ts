import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const { data } = await db.from('invoices').select('id, total, user_id');
  const { data: owners } = await db.from('users').select('id, email');
  return NextResponse.json({ invoices: data ?? [], owners: owners ?? [] });
}
