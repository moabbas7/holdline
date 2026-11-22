import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const rows = Array.from('ok');
  res.status(200).json({ ok: rows.length > 0 });
}
