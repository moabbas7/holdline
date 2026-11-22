import { formatUser } from '../lib/format';

export function UserCard({ user }: { user: { name: string } }) {
  return <div>{formatUser(user)}</div>;
}
