import type { Pool } from "mysql2/promise";

/**
 * Converts a name into a URL-safe slug base.
 * "Muhammad Ali Khan" -> "muhammad-ali-khan"
 */
export function slugifyBase(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150); // leave room for numeric suffixes within varchar(191)
}

/**
 * Generates a unique slug for a new employee, appending "-2", "-3", etc.
 * if the base slug is already taken. `excludeEmployeeId` lets an update
 * operation check uniqueness against everyone EXCEPT the record being edited.
 */
export async function generateUniqueSlug(
  pool: Pool,
  fullName: string,
  excludeEmployeeId?: string
): Promise<string> {
  const base = slugifyBase(fullName);
  if (!base) {
    throw new Error("Could not generate a slug from the provided name");
  }

  let candidate = base;
  let suffix = 2;

  // Bounded loop — guards against a pathological/looping edge case
  // rather than relying on unbounded recursion or a while(true).
  for (let attempt = 0; attempt < 50; attempt++) {
    const [rows] = await pool.query(
      excludeEmployeeId
        ? "SELECT employee_id FROM employees WHERE slug = ? AND employee_id != ? LIMIT 1"
        : "SELECT employee_id FROM employees WHERE slug = ? LIMIT 1",
      excludeEmployeeId ? [candidate, excludeEmployeeId] : [candidate]
    );

    if ((rows as unknown[]).length === 0) {
      return candidate;
    }

    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  throw new Error("Could not generate a unique slug after multiple attempts");
}