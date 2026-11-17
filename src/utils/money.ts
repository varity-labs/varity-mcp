/**
 * The one rendering of a USD price: exactly two decimals, grouped thousands.
 * A positive amount below one cent renders as "<$0.01", never "$0.00".
 */
export function usd(amount: number): string {
  if (amount > 0 && amount < 0.005) return "<$0.01";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** An app or template price: the platform quotes a monthly maximum. */
export function monthlyMaximum(amount: number): string {
  return `up to ${usd(amount)}/month (monthly maximum, USD)`;
}
