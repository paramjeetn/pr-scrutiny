import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined | null,
  secret: string
): boolean {
  if (!signatureHeader) return false

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')

  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
  } catch {
    // Buffer length mismatch means different lengths — definitely not equal
    return false
  }
}
