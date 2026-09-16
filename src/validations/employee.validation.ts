import { z } from "zod";

const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase, alphanumeric, hyphen-separated")
  .max(191);

export const createEmployeeSchema = z.object({
  full_name: z.string().trim().min(2, "Full name is required").max(191),
  designation: z.string().trim().min(2, "Designation is required").max(191),
  content: z.string().max(20000).optional().default(""),
  display_order: z.coerce.number().int().optional().default(0),
  slug: slugField.optional(),
  general_information: z.string().max(20000).optional(),
  employment_details: z.string().max(20000).optional(),
  key_responsibilities: z.string().max(20000).optional()

});

export const updateEmployeeSchema = z.object({
  full_name: z.string().min(1).max(191).optional(),
  designation: z.string().max(191).optional(),
  content: z.string().max(20000).optional(),
  general_information: z.string().max(20000).optional(),
  employment_details: z.string().max(20000).optional(),
  key_responsibilities: z.string().max(20000).optional(),
  display_order: z.coerce.number().int().optional(),
  status: z.enum(["active", "hidden"]).optional(),
  slug: z.string().max(191).optional(),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;