import { toggleTodo } from '@/lib/api';

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export function TodoItem({ todo }: { todo: Todo }) {
  return <li onClick={() => toggleTodo(todo.id)}>{todo.title}</li>;
}
