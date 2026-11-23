import { Router } from 'express';
import { prisma } from '../db';

export const router = Router();

router.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
  res.json(users);
});
