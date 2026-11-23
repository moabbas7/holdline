import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';

export const app = new Hono();

app.get('/users/:email', async (c) => {
  const rows = await db.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.email, c.req.param('email')));
  return c.json(rows);
});
