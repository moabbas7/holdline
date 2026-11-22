import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
  const { data } = await supabase.from('users').select('*');
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { data } = await supabase.from('users').insert(body).select();
  return NextResponse.json(data);
}
