import express from 'express';
import { router as orders } from './routes/orders.js';

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use('/api/orders', orders);

app.listen(Number(process.env.PORT ?? 3000));
