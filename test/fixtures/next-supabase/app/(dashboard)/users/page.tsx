'use client';
import { useEffect, useState } from 'react';
import { UserCard } from '@/components';

export default function UsersPage() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch('/api/users').then((r) => r.json()).then(setUsers);
  }, []);
  return <div>{users.map((u) => <UserCard key={u.id} user={u} />)}</div>;
}
