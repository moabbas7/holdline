import axios from 'axios';

export async function listOrders() {
  const { data } = await axios.get('/api/orders');
  return data.orders.map((o: { id: number; total: number }) => `${o.id}: ${o.total}`);
}

export async function orderSkus(id: string) {
  const res = await fetch(`/api/orders/${id}`);
  const order = await res.json();
  return order.items.map((i: { sku: string }) => i.sku);
}

export async function placeOrder(sku: string) {
  const res = await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ sku, qty: 1 }) });
  return res.ok;
}
