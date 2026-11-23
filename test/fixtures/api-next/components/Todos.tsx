import useSWR from 'swr';

export function Todos() {
  const { data: todos } = useSWR<{ id: number; title: string; done: boolean }[]>('/api/todos');
  return <ul>{todos?.map((t) => <li key={t.id}>{t.title}{t.done ? ' ✓' : ''}</li>)}</ul>;
}
