export interface User {
  id: number;
  name: string;
  email?: string;
  createdAt: Date;
  role: 'admin' | 'member';
  /** Not serialised: functions are dropped from JSON. */
  greet?: () => string;
}
