'use client';
import { createPost } from '@/app/actions';

export default function NewPostForm({ authorId }: { authorId: string }) {
  return <form action={async (fd: FormData) => createPost(authorId, String(fd.get('title')))} />;
}
