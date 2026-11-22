import express from 'express';
import { db } from '../db/client.js';
import { customers } from '../db/schema.js';

export const customersRouter = express.Router();

customersRouter.get('/', async (_req, res) => {
  res.json(await db.select().from(customers));
});
