export async function createUser(name: string) {
  const res = await fetch('/api/users', { method: 'POST', body: JSON.stringify({ name }) });
  const { id } = await res.json();
  return id;
}

export async function removeUser(id: string) {
  await fetch(`/api/users/${id}`, { method: 'DELETE' });
}
