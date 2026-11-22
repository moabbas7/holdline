import { TodoList } from '@/components';
import { useTodos } from './hooks/useTodos.js';
import logo from '/vite.svg';

export default function App() {
  const todos = useTodos();
  return (
    <div>
      <img src={logo} />
      <TodoList todos={todos} />
    </div>
  );
}
