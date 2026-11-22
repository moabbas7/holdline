import { PrismaClient } from '@prisma/client';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export const prisma = new PrismaClient();
export const pool = new pg.Pool();
export const db = drizzle(pool);
