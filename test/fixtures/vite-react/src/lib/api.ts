import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export async function fetchTodos() {
  const { data } = await api.get('/todos');
  return data;
}

export async function toggleTodo(id: number) {
  return fetch(`/api/todos/${id}/toggle`, { method: 'POST' });
}

export default api;
