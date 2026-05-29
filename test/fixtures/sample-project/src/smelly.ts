/* eslint-disable */
// A module intentionally full of code smells, for search_ast and complexity tests.

export async function processItems(items: any[]): Promise<number> {
  let total = 0;
  // TODO: parallelize this loop
  for (const item of items) {
    const result = await fetchValue(item); // await in loop
    total += result;
  }
  return total;
}

async function fetchValue(item: any): Promise<number> {
  try {
    return await Promise.resolve(item.value!);
  } catch (e) {
    // empty catch — swallows the error
  }
  return 0;
}

export function classify(n: number): string {
  // FIXME: handle negatives properly
  if (n < 0) {
    return "negative";
  } else if (n === 0) {
    return "zero";
  } else if (n < 10) {
    return "small";
  } else if (n < 100) {
    return "medium";
  } else if (n < 1000) {
    return "large";
  } else {
    return "huge";
  }
}

export function logIt(value: unknown): void {
  // @ts-ignore intentionally suppressed
  console.log("value is", value);
  console.error("done");
}

const data: any = { value: 1 };
export const forced = data.value!;
