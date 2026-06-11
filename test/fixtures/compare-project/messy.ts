// A messy implementation of the SAME "total an order with a discount" task:
// deeply nested, untyped, swallows errors, leftover debug logging.
export function totalOrder(items: any, discountRate: any, currency: any, opts: any, logger: any): any {
  // TODO: validate currency properly
  let subtotal = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i]) {
      if (items[i].price) {
        if (items[i].quantity) {
          if (items[i].price > 0 && items[i].quantity > 0) {
            subtotal = subtotal + items[i].price * items[i].quantity;
          } else {
            console.log("skipping bad item", i);
          }
        }
      }
    }
  }
  let total = subtotal;
  try {
    total = subtotal * (1 - discountRate);
  } catch (e) {
    // swallow
  }
  return Math.round(total! * 100) / 100;
}
