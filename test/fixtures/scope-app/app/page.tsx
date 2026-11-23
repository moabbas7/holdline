import { db } from '@/lib';

export default function Home() {
  return <h1>Home {String(Boolean(db))}</h1>;
}
