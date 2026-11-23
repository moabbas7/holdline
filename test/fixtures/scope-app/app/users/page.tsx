import { UserCard } from '@/components/UserCard';
import { formatName } from '@/lib/format';

export default async function UsersPage() {
  const res = await fetch('/api/users');
  const users: { id: string; first: string; last: string }[] = await res.json();
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>
          <UserCard name={formatName(u.first, u.last)} />
        </li>
      ))}
    </ul>
  );
}
