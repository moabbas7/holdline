import express from 'express';
import ordersRouter from './routes/orders.js';
import { customersRouter } from './routes/customers.js';

const app = express();
app.use(express.json());
app.use('/api/orders', ordersRouter);
app.use('/api/customers', customersRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(3000);
