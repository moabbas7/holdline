import type { NextApiRequest, NextApiResponse } from 'next';

type Todo = { id: number; title: string; done: boolean };

export default function handler(req: NextApiRequest, res: NextApiResponse<Todo[] | Todo | { error: string }>) {
  if (req.method === 'GET') {
    return res.status(200).json([{ id: 1, title: 'a', done: false }]);
  }
  if (req.method === 'POST') {
    const { title } = req.body;
    return res.status(201).json({ id: 2, title: String(title), done: false });
  }
  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ error: 'Method not allowed' });
}
