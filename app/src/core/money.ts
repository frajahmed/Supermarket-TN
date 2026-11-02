export function formatTndMinor(minorUnits: string, locale: string): string {
  if (!/^\d+$/.test(minorUnits)) throw new Error('Betrag muss eine positive Ganzzahl sein');
  const value = BigInt(minorUnits);
  const major = value / 1000n;
  const fraction = String(value % 1000n).padStart(3, '0');
  const integer = new Intl.NumberFormat(locale).format(major);
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? ',';
  return `${integer}${decimal}${fraction}`;
}
