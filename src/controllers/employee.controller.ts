import { Request, Response } from "express";
import crypto from "crypto";
import sanitizeHtml from "sanitize-html";
import { pool } from "../config/db"; // <-- adjust to your actual db pool export path
import {
  uploadBufferToCloudinary,
  deleteFromCloudinary,
} from "../middlewares/upload.middleware";
import { generateUniqueSlug } from "../utils/slugify";
import {
  createEmployeeSchema,
  updateEmployeeSchema,
} from "../validations/employee.validation";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "b", "strong", "i", "em", "a", "br", "ul", "ol", "li"],
  allowedAttributes: { a: ["href", "target", "rel"] },
  // Force safe rel/target on links so staff-authored content can't be used
  // for tabnabbing on the public site.
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
  },
};

function sanitizeContent(html: string | undefined | null): string {
  if (!html) return "";
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

// ---------------------------------------------------------------------------
// GET /api/employees  (public — directory listing)
// ---------------------------------------------------------------------------
export async function listEmployees(_req: Request, res: Response) {
  try {
    const [rows] = await pool.query(
      `SELECT employee_id, slug, full_name, designation, photo_url, display_order
       FROM employees
       WHERE status = 'active'
       ORDER BY display_order ASC, full_name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("listEmployees error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch employees" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/employees/admin  (staff/admin — all employees, any status)
// ---------------------------------------------------------------------------
export async function listEmployeesForAdmin(_req: Request, res: Response) {
  try {
    const [rows] = await pool.query(
      `SELECT employee_id, slug, full_name, designation, photo_url, display_order, status
       FROM employees
       ORDER BY display_order ASC, full_name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("listEmployeesForAdmin error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch employees" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/employees/slug/:slug  (public — QR code target)
// ---------------------------------------------------------------------------
export async function getEmployeeBySlug(req: Request, res: Response) {
  const { slug } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT employee_id, slug, full_name, designation, photo_url, content, status
       FROM employees
       WHERE slug = ?
       LIMIT 1`,
      [slug]
    );
    const employee = (rows as any[])[0];

    if (!employee || employee.status !== "active") {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    res.json({ success: true, data: employee });
  } catch (err) {
    console.error("getEmployeeBySlug error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch employee" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/employees/:employee_id  (staff/admin — for edit form prefill)
// ---------------------------------------------------------------------------
export async function getEmployeeById(req: Request, res: Response) {
  const { employee_id } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM employees WHERE employee_id = ? LIMIT 1`,
      [employee_id]
    );
    const employee = (rows as any[])[0];

    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    res.json({ success: true, data: employee });
  } catch (err) {
    console.error("getEmployeeById error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch employee" });
  }
}

// ---------------------------------------------------------------------------
// POST /api/employees  (staff/admin, multipart/form-data with "photo")
// ---------------------------------------------------------------------------
export async function createEmployee(req: Request, res: Response) {
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { full_name, designation, content, display_order } = parsed.data;
  const createdBy = (req as any).user?.user_id ?? null;

  let photoUrl: string | null = null;
  let photoPublicId: string | null = null;

  try {
    // Upload photo first — if this fails we bail before touching the DB.
    if (req.file) {
      const uploaded = await uploadBufferToCloudinary(req.file.buffer);
      photoUrl = uploaded.secure_url;
      photoPublicId = uploaded.public_id;
    }

    const employeeId = crypto.randomUUID();
    const slug = await generateUniqueSlug(pool, full_name);
    const sanitizedContent = sanitizeContent(content);

    await pool.query(
      `INSERT INTO employees
        (employee_id, slug, full_name, designation, photo_url, photo_public_id,
         content, display_order, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        employeeId,
        slug,
        full_name,
        designation,
        photoUrl,
        photoPublicId,
        sanitizedContent,
        display_order,
        createdBy,
      ]
    );

    res.status(201).json({
      success: true,
      data: {
        employee_id: employeeId,
        slug,
        full_name,
        designation,
        photo_url: photoUrl,
        content: sanitizedContent,
        display_order,
        status: "active",
      },
    });
  } catch (err) {
    // Roll back the Cloudinary upload if the DB insert failed, so we don't
    // leak an orphaned image with no corresponding row.
    if (photoPublicId) await deleteFromCloudinary(photoPublicId);
    console.error("createEmployee error:", err);
    res.status(500).json({ success: false, message: "Failed to create employee" });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/employees/:employee_id  (staff/admin, optional new "photo")
// ---------------------------------------------------------------------------
export async function updateEmployee(req: Request, res: Response) {
  const { employee_id } = req.params;

  const parsed = updateEmployeeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: parsed.error.flatten().fieldErrors,
    });
  }
  const updates = parsed.data;

  try {
    const [existingRows] = await pool.query(
      `SELECT * FROM employees WHERE employee_id = ? LIMIT 1`,
      [employee_id]
    );
    const existing = (existingRows as any[])[0];
    if (!existing) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    // Resolve slug: explicit override > unchanged (name-change does NOT
    // auto-regenerate the slug — QR codes already printed depend on it).
    let nextSlug = existing.slug;
    if (updates.slug && updates.slug !== existing.slug) {
      const [slugRows] = await pool.query(
        `SELECT employee_id FROM employees WHERE slug = ? AND employee_id != ? LIMIT 1`,
        [updates.slug, employee_id]
      );
      if ((slugRows as unknown[]).length > 0) {
        return res.status(409).json({
          success: false,
          message: `Slug "${updates.slug}" is already in use by another employee`,
        });
      }
      nextSlug = updates.slug;
    }

    let photoUrl: string = existing.photo_url;
    let photoPublicId: string | null = existing.photo_public_id;
    const oldPublicId = existing.photo_public_id;

    if (req.file) {
      const uploaded = await uploadBufferToCloudinary(req.file.buffer);
      photoUrl = uploaded.secure_url;
      photoPublicId = uploaded.public_id;
    }

    const nextValues = {
      full_name: updates.full_name ?? existing.full_name,
      designation: updates.designation ?? existing.designation,
      content:
        updates.content !== undefined
          ? sanitizeContent(updates.content)
          : existing.content,
      display_order: updates.display_order ?? existing.display_order,
      status: updates.status ?? existing.status,
    };

    await pool.query(
      `UPDATE employees
       SET slug = ?, full_name = ?, designation = ?, photo_url = ?, photo_public_id = ?,
           content = ?, display_order = ?, status = ?, updated_at = CURRENT_TIMESTAMP(6)
       WHERE employee_id = ?`,
      [
        nextSlug,
        nextValues.full_name,
        nextValues.designation,
        photoUrl,
        photoPublicId,
        nextValues.content,
        nextValues.display_order,
        nextValues.status,
        employee_id,
      ]
    );

    // Only delete the old image after the DB write succeeds, and only
    // if a new one actually replaced it.
    if (req.file && oldPublicId) {
      await deleteFromCloudinary(oldPublicId);
    }

    res.json({
      success: true,
      data: { employee_id, slug: nextSlug, photo_url: photoUrl, ...nextValues },
    });
  } catch (err) {
    console.error("updateEmployee error:", err);
    res.status(500).json({ success: false, message: "Failed to update employee" });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/employees/:employee_id  (staff/admin — soft delete)
// ---------------------------------------------------------------------------
export async function deleteEmployee(req: Request, res: Response) {
  const { employee_id } = req.params;
  try {
    const [result]: any = await pool.query(
      `UPDATE employees SET status = 'hidden', updated_at = CURRENT_TIMESTAMP(6)
       WHERE employee_id = ?`,
      [employee_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    res.json({ success: true, message: "Employee hidden from public directory" });
  } catch (err) {
    console.error("deleteEmployee error:", err);
    res.status(500).json({ success: false, message: "Failed to delete employee" });
  }
}