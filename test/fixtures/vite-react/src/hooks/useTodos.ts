import { useEffect, useState } from 'react';
import { fetchTodos } from '../lib/api';
import type { Todo } from '@/components/TodoItem';

export function useTodos(): Todo[] {
  const [todos, setTodos] = useState<Todo[]>([]);
  useEffect(() => {
    fetchTodos().then(setTodos);
  }, []);
  return todos;
}
