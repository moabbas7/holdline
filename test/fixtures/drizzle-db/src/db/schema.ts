import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgEnum, pgPolicy, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

export const statusEnum = pgEnum('status', ['draft', 'published']);

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull().unique(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(t.email)],
);

export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: statusEnum('status').default('draft'),
    pinned: boolean('pinned').default(false),
  },
  (t) => [
    index('posts_author_idx').on(t.authorId),
    pgPolicy('authors can read', { for: 'select', to: 'authenticated', using: sql`true` }),
  ],
);
