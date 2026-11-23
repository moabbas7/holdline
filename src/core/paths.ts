import path from 'node:path';

/** A native path with `/` separators, as git and holdline's output use on every platform. */
export const posix = (p: string) => p.split(path.sep).join('/');
