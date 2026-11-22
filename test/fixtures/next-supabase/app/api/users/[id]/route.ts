import { NextResponse } from 'next/server';
import { supabase } from '../../../../lib/supabase';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { data: user } = await supabase.from('users').select('*').eq('id', params.id).single();
  const { data: posts } = await supabase.from('posts').select('*').eq('author_id', params.id);
  return NextResponse.json({ user, posts });
}
