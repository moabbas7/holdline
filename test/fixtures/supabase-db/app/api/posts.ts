import { supabase } from '@/lib/supabase';

export const recentPosts = () => supabase.from('posts').select('id, title').order('id');
