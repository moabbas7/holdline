import type { User } from './types';

const users: User[] = [];

export async function getUsers(): Promise<User[]> {
  return users;
}

export async function findUser(id: string): Promise<{ id: number; name: string; city: string; zip: string | null } | null> {
  return id ? { id: 1, name: 'a', city: 'b', zip: null } : null;
}
