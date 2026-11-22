import { cn } from '@/cn';

export function Card({ title }: { title: string }) {
  return <div className={cn('card')}>{title}</div>;
}
