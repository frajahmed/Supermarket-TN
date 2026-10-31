/**
 * Geldbeträge werden überall als Ganzzahl in Minor Units geführt.
 * TND hat 3 Nachkommastellen (1 TND = 1000 Millimes), EUR/USD 2.
 * Niemals Floats für Beträge verwenden.
 */
const MINOR_UNITS: Record<string, number> = { TND: 3, EUR: 2, USD: 2 };

export function minorUnits(currency: string): number {
  const digits = MINOR_UNITS[currency];
  if (digits === undefined) throw new Error(`Unbekannte Währung: ${currency}`);
  return digits;
}

/** "1,350" bzw. "1.350" (TND) -> 1350 Millimes. Wirft bei zu vielen Nachkommastellen. */
export function parseAmount(input: string, currency: string): bigint {
  const digits = minorUnits(currency);
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.');
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error(`Ungültiger Betrag: ${input}`);
  const [, sign, whole, frac = ''] = match;
  if (frac.length > digits) throw new Error(`Zu viele Nachkommastellen für ${currency}: ${input}`);
  const value = BigInt(whole) * 10n ** BigInt(digits) + BigInt(frac.padEnd(digits, '0') || '0');
  return sign ? -value : value;
}

/** Anzeige in der Sprache des Nutzers, z. B. formatAmount(1350n, 'TND', 'ar-TN'). */
export function formatAmount(minor: bigint, currency: string, locale: string): string {
  const digits = minorUnits(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(minor) / 10 ** digits);
}

/**
 * Steuer aus Bruttobetrag (TTC) herausrechnen, kaufmännisch gerundet.
 * rateBp in Basispunkten: 1900 = 19 %.
 */
export function taxFromGross(grossMinor: bigint, rateBp: number): bigint {
  const rate = BigInt(rateBp);
  const numerator = grossMinor * rate;
  const denominator = 10_000n + rate;
  return (numerator * 2n + denominator) / (denominator * 2n); // Rundung half-up für positive Beträge
}
