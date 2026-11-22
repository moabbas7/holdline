import { formatUser } from '@/lib/format';
import NewPostForm from '@/components/NewPostForm';

export default async function UserPage({ params }: { params: { id: string } }) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/users/${params.id}`, { method: 'GET' });
  const { user } = await res.json();
  return (
    <main>
      <h1>{formatUser(user)}</h1>
      <NewPostForm authorId={params.id} />
    </main>
  );
}
