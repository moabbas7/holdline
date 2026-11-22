'use server';
import { supabase } from '@/lib/supabase';

export async function createPost(authorId: string, title: string) {
  await supabase.from('posts').insert({ author_id: authorId, title });
}
