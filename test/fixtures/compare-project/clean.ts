// A clean implementation of "total an order with a discount".
export interface LineItem {
  price: number;
  quantity: number;
}

export function totalOrder(items: LineItem[], discountRate: number): number {
  if (discountRate < 0 || discountRate > 1) {
    throw new RangeError("discountRate must be between 0 and 1");
  }
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return round2(subtotal * (1 - discountRate));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
