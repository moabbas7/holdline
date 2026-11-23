import { NextResponse } from 'next/server';
import { loadRemote } from 'untyped-remote-client';

export async function GET() {
  const data = await loadRemote();
  return NextResponse.json(data);
}
