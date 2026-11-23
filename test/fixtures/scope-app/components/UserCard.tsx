import { Avatar } from './Avatar';

export function UserCard({ name }: { name: string }) {
  return (
    <div className="user-card">
      <Avatar />
      {name}
    </div>
  );
}
