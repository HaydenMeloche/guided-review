import { createHash } from 'node:crypto';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
