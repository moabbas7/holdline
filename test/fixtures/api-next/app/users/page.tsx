'use client';
import { useEffect, useState } from 'react';

export default function UsersPage() {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((data) => {
        setNames(data.users.map((u: { name: string }) => u.name));
        console.log(data.total);
      });
  }, []);
  return <ul>{names.map((n) => <li key={n}>{n}</li>)}</ul>;
}
