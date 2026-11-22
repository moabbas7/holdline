import { TodoItem, type Todo } from './TodoItem';

export function TodoList({ todos }: { todos: Todo[] }) {
  return <ul>{todos.map((t) => <TodoItem key={t.id} todo={t} />)}</ul>;
}
