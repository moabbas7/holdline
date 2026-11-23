import { InvoiceTable } from '@/components/InvoiceTable';
import { formatMoney } from '@/lib/format';

export default async function BillingPage() {
  const res = await fetch('/api/invoices');
  const { invoices } = await res.json();
  return <InvoiceTable rows={invoices} format={formatMoney} />;
}
