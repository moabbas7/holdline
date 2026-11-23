export function InvoiceTable({ rows, format }: { rows: { id: string; total: number }[]; format: (n: number) => string }) {
  return (
    <table>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{format(r.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
