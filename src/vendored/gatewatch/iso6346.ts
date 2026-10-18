/**
 * ISO 6346 container number validation.
 */

export const CONTAINER_LETTER_VALUES: Record<string, number> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19,
  J: 20, K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29,
  S: 30, T: 31, U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};

/**
 * Computes the ISO 6346 check digit for the first 10 characters.
 * @param first10 4 letters + 6 digits (uppercase, no separators).
 * @returns check digit 0-9 (10 is mapped to 0).
 */
export function checkDigitFor(first10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    let value: number;
    if (i < 4) {
      value = CONTAINER_LETTER_VALUES[ch] ?? 0;
    } else {
      value = parseInt(ch, 10);
    }
    sum += value * Math.pow(2, i);
  }
  const mod = sum % 11;
  return mod === 10 ? 0 : mod;
}

/**
 * Normalizes a container number: uppercase, strip spaces and dashes.
 * @param raw raw input string.
 * @returns normalized string or "" if empty.
 */
export function normalizeContainer(raw: string): string {
  if (!raw) return "";
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Parses a container number into its parts.
 * @param raw raw input string.
 * @returns parsed object or null if format is invalid.
 */
export function parseContainer(raw: string): {
  owner: string;
  serial: string;
  check: string;
  valid: boolean;
  reason?: string;
} | null {
  const normalized = normalizeContainer(raw);
  if (normalized.length !== 11) return null;
  if (!/^[A-Z]{4}[0-9]{7}$/.test(normalized)) return null;

  const owner = normalized.slice(0, 4);
  const serial = normalized.slice(4, 10);
  const check = normalized.slice(10);
  const expected = checkDigitFor(normalized.slice(0, 10));
  const valid = expected === parseInt(check, 10);

  return {
    owner,
    serial,
    check,
    valid,
    reason: valid ? undefined : "bad-check-digit",
  };
}

/**
 * Checks if a container number is valid according to ISO 6346.
 * @param raw raw input string.
 * @returns true if valid.
 */
export function isValidContainer(raw: string): boolean {
  const parsed = parseContainer(raw);
  return parsed !== null && parsed.valid;
}

/**
 * Extracts container number candidates from OCR text.
 * @param text OCR text.
 * @returns array of normalized 11-char container numbers (deduped).
 */
export function extractContainerCandidates(text: string): string[] {
  const re = /[A-Z]{4}[\s-]?[0-9]{6}[\s-]?[0-9]/gi;
  const matches = text.match(re) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    const normalized = normalizeContainer(m);
    if (normalized.length === 11 && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}
