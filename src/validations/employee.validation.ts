import { z } from "zod";

export const createEmployeeSchema = z.object({
  full_name: z.string().trim().min(2, "Full name is required").max(191),
  designation: z.string().trim().min(2, "Designation is required").max(191),
  content: z.string().max(20000).optional().default(""),
  display_order: z.coerce.number().int().optional().default(0),
});

export const updateEmployeeSchema = z.object({
  full_name: z.string().trim().min(2).max(191).optional(),
  designation: z.string().trim().min(2).max(191).optional(),
  content: z.string().max(20000).optional(),
  display_order: z.coerce.number().int().optional(),
  status: z.enum(["active", "hidden"]).optional(),
  // Allow explicit slug override on edit, but keep it constrained —
  // uniqueness is still checked server-side against the DB.
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase, alphanumeric, hyphen-separated")
    .max(191)
    .optional(),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;