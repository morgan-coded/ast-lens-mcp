export const dbValue = 7;

export async function loadDa(): Promise<number> {
  const mod = await import("./da");
  return mod.daValue();
}
