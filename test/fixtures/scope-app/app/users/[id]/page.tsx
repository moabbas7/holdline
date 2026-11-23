import { UserCard } from '@/components/UserCard';

export default function UserPage({ params }: { params: { id: string } }) {
  return <UserCard name={params.id} />;
}
