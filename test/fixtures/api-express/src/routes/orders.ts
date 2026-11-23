import { Router } from 'express';

export const router = Router();

interface Order {
  id: number;
  total: number;
  items: { sku: string; qty: number }[];
  note?: string;
}

const orders: Order[] = [];

router.get('/', (req, res) => {
  const status = req.query.status;
  res.json({ orders, status: String(status ?? 'all') });
});

router.post('/', (req, res) => {
  const { sku, qty } = req.body;
  if (!sku) {
    return res.status(400).json({ error: 'sku required' });
  }
  res.status(201).json({ id: 2, sku: String(sku), qty: Number(qty) });
});

router.get('/:id', getOrder);

function getOrder(req: { params: { id: string } }, res: any) {
  const order = orders.find((o) => String(o.id) === req.params.id);
  if (!order) return res.sendStatus(404);
  res.json(order);
}
