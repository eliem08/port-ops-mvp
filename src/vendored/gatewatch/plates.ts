/**
 * Moroccan truck plate helpers.
 *
 * REAL-WORLD FORMAT (verified against Wikipedia "Vehicle registration
 * plates of Morocco" and Hespress, Oct 2026):
 * - Since 2000, standard plates are `DDDDD | <Arabic series letter> | NN`:
 *   1–5 digit serial, ONE Arabic series letter (allocated so far: أ ب د ه و
 *   ط ي), and a 1–2 digit prefecture/province code (1–88). Black on white.
 * - Since Aug 2026 (Decision No. 640.26), NEW plates add the Latin-letter
 *   equivalent of the series letter next to the Arabic one
 *   (model: `MA | 00000 ب 00 B`). Older Arabic-only plates stay valid until
 *   first transfer of ownership.
 * - Temporary WW plates: `###### WW` black-on-white stickers, valid 1 month,
 *   national (no region code).
 *
 * SUPPORTED BY THIS PARSER (normalized to dash-separated, uppercase):
 * - Standard series with a LATIN series letter: `NNNNN-L-NN`, e.g.
 *   "78452-A-17" (4–6 digits, 1–2 letters, 1–3 digit suffix). This matches
 *   the Latin equivalent on post-2026 dual-script plates and the Latin
 *   series used on export/transit paperwork. The parser is deliberately
 *   permissive on digit counts (4–6 vs. the real 1–5) — over-accepting a
 *   misread is safer than rejecting a valid plate.
 * - Optional region suffix: `NNNNN-L-NN-XXX`, e.g. "78452-A-17-CAS".
 *   DEMO-ONLY convention: real Moroccan plates carry a NUMERIC prefecture
 *   code (1–88), not Latin city codes. The suffix list below is accepted
 *   only so demo paperwork-style labels parse; it is not a real format.
 * - Temporary plates: `WW-NNNNNN` or `NNNNNN-WW` (matches the real
 *   `###### WW` sticker series).
 *
 * NOT SUPPORTED (routed to human review, never guessed):
 * - Arabic-script series letters (the majority of plates on the road today
 *   — needs an ara.traineddata OCR engine, see the methodology page).
 * - The `MA |` country-code prefix of the 2026 unified plate model.
 * - W18 dealer temp plates (`##### W 18`, red on white).
 * - CD diplomatic plates (blue, `CD` + number pairs).
 * - Government plates (6 digits + `M`/`ج`, white on black).
 * - Trailer plates (`####-##`, white on red).
 * - Pre-2000 formats.
 */

/**
 * DEMO-ONLY suffix list. Real Moroccan plates use a NUMERIC prefecture code
 * (1–88), not Latin city codes — these are accepted solely so
 * paperwork-style demo labels like "78452-A-17-CAS" parse. Only these codes
 * are accepted as a suffix; any other trailing word is treated as OCR
 * noise, not a region.
 */
export const REGION_CODES = [
  'CAS', // Casablanca
  'RAB', // Rabat
  'FES', // Fès
  'MAR', // Marrakech
  'TAN', // Tangier
  'AGD', // Agadir
  'MEK', // Meknès
  'OUJ', // Oujda
  'KEN', // Kénitra
  'SAF', // Safi
  'SET', // Settat
  'ELJ', // El Jadida
  'BER', // Berrechid
  'NDR', // Nador
  'ERR', // Errachidia
  'LAA', // Laâyoune
  'DAK', // Dakhla
  'TAR', // Taroudant
  'TIZ', // Tiznit
  'ZAG', // Zagora
  'BEN', // Beni Mellal
  'KHG', // Khouribga
  'MDI', // Mohammedia
  'ALH', // Al Hoceima
  'CHC', // Chefchaouen
  'SIF', // Sidi Ifni
  'JDI', // Sidi Kacem / region code used on transit paperwork
  'TET', // Tétouan
  'LAR', // Larache
  'TAZ', // Taza
  'IFR', // Ifrane
  'KHE', // Khémisset
  'BEM', // Béni Mellal region variant seen on some plates
  'OUA', // Ouarzazate
  'TNG', // Tangier variant
  'GUE', // Guelmim
  'SMR', // Smara
  'BOJ', // Boujdour
] as const;

const REGION_ALT = REGION_CODES.join('|');

/**
 * Normalizes a plate string: uppercase, trim, collapse whitespace,
 * replace en/em dashes with "-", and canonicalize WW temporary plates
 * (`WW123456` → `WW-123456`, `123456WW` → `123456-WW`).
 * @param raw raw input string.
 * @returns normalized string or "" if empty.
 */
export function normalizePlate(raw: string): string {
  if (!raw) return '';
  const cleaned = raw
    .toUpperCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[–—]/g, '-');
  const wwPrefix = cleaned.match(/^WW(\d{6})$/);
  if (wwPrefix) return `WW-${wwPrefix[1]}`;
  const wwSuffix = cleaned.match(/^(\d{6})WW$/);
  if (wwSuffix) return `${wwSuffix[1]}-WW`;
  return cleaned;
}

/** Plausible plate shapes (union of all supported formats). */
export const PLATE_RE = new RegExp(
  `^(?:[0-9]{4,6}-[A-Z]{1,2}-[0-9]{1,3}(?:-(?:${REGION_ALT}))?|WW-[0-9]{6}|[0-9]{6}-WW)$`,
);

/**
 * Checks if a normalized plate string is plausible.
 * @param s normalized plate string.
 * @returns true if plausible.
 */
export function isPlausiblePlate(s: string): boolean {
  return PLATE_RE.test(s);
}

/**
 * Extracts plate candidates from OCR text.
 * Matches the standard series (with optional validated region suffix) and
 * both WW temporary-plate shapes. Results are normalized and deduped.
 * @param text OCR text.
 * @returns array of normalized plate strings (deduped).
 */
export function extractPlateCandidates(text: string): string[] {
  const patterns: RegExp[] = [
    // Standard series with optional region suffix (only known codes count).
    new RegExp(
      `[0-9]{4,6}\\s*[-–—]\\s*[A-Z]{1,2}\\s*[-–—]\\s*[0-9]{1,3}(?:\\s*[-–—]\\s*(?:${REGION_ALT}))?`,
      'gi',
    ),
    // Temporary plates, WW first or last.
    /WW\s*[-–—]?\s*[0-9]{6}/gi,
    /[0-9]{6}\s*[-–—]?\s*WW/gi,
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const re of patterns) {
    const matches = text.match(re) ?? [];
    for (const m of matches) {
      const normalized = normalizePlate(m);
      if (normalized && isPlausiblePlate(normalized) && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
  }
  return result;
}
