/**
 * Shared order-date formatting.
 *
 * Lives in its own module so the "is this you?" card and the order list render
 * the SAME date for the same order — two different formats on one screen makes a
 * customer wonder whether they are looking at two different orders.
 */
export function formatOrderDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
