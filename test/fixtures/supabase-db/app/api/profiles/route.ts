import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
  const { data } = await supabase.from('profiles').select('id, email, display_name').eq('role', 'owner');
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const { email } = await req.json();
  // "email" in a non-query string must not be flagged: Enter your email
  const { data } = await supabase.from('profiles').insert({ email }).select();
  return NextResponse.json(data);
}
