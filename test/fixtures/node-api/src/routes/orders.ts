import { Router } from 'express';
import { pool, prisma } from '../db/client.js';

const router = Router();

router.get('/', async (_req, res) => {
  res.json(await prisma.order.findMany());
});

router.get('/:id/invoice', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT i.* FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.id = $1',
    [req.params.id],
  );
  res.json(rows[0]);
});

export default router;
