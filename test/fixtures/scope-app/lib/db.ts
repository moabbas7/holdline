import { createClient } from '@supabase/supabase-js';

export const db = createClient('http://127.0.0.1:54321', 'anon');
