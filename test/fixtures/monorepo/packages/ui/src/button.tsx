import { cn } from '@/cn';

export function Button({ label }: { label: string }) {
  return <button className={cn('btn')}>{label}</button>;
}
