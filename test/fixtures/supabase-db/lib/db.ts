import { Pool } from 'pg';

const pool = new Pool();

export async function profileEmails(orgId: string) {
  const { rows } = await pool.query('select id, email from profiles where org_id = $1', [orgId]);
  return rows;
}
