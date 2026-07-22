import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../config/db";

export const createMarketer = async (req: Request, res: Response) => {
  const connection = await pool.getConnection(); // NOTE: pool.connect() -> pool.getConnection()

  try {
    const {
      email,
      full_name,
      password,
      commission_type = "percentage",
      commission_value,
    } = req.body;

    const adminId = req.user!.user_id;

    if (!email || !full_name || !password || !commission_value) {
      return res.status(400).json({
        message: "Missing required fields",
      });
    }

    await connection.beginTransaction();

    // 1️⃣ Check if user already exists (including soft-deleted)
    // NOTE: $1 -> ?
    const [existingUserRows] = await connection.query(
      `SELECT user_id, status FROM users WHERE email = ?`,
      [email]
    );

    if ((existingUserRows as any[]).length > 0) {
      const user = (existingUserRows as any[])[0];

      // 1a. If active/suspended — reject as before
      if (user.status !== "deleted") {
        await connection.rollback();
        return res.status(409).json({
          message: "User with this email already exists",
        });
      }

      // 1b. If soft-deleted — reactivate with new credentials
      const passwordHash = await bcrypt.hash(password, 10);

      await connection.query(
        `
        UPDATE users
        SET
          full_name     = ?,
          password_hash = ?,
          status        = 'active',
          updated_at    = CURRENT_TIMESTAMP
        WHERE user_id = ?
        `,
        [full_name, passwordHash, user.user_id]
      );

      // ⚠️ IMPORTANT WATCH-OUT: this UPDATE used `RETURNING marketer_id` to
      // get back the marketer_id of the row it just reactivated. MySQL has
      // no RETURNING on UPDATE — and unlike the earlier delete handlers,
      // here we actually NEED the marketer_id back (it's returned in the
      // response), and we don't already have it sitting in a variable like
      // we did with customerId/userId in other handlers. So this requires
      // a genuinely new pattern: run a SELECT immediately after the UPDATE,
      // scoped by user_id, to fetch the marketer_id we just touched.
      await connection.query(
        `
        UPDATE marketers
        SET
          commission_type  = ?,
          commission_value = ?,
          status           = 'active',
          created_by       = ?
        WHERE user_id = ?
        `,
        [commission_type, commission_value, adminId, user.user_id]
      );

      const [reactivatedRows] = await connection.query(
        `SELECT marketer_id FROM marketers WHERE user_id = ?`,
        [user.user_id]
      );
      const reactivatedMarketerId = (reactivatedRows as any[])[0].marketer_id;

      await connection.commit();

      return res.status(200).json({
        message: "Marketer reactivated successfully",
        data: {
          user_id: user.user_id,
          marketer_id: reactivatedMarketerId,
          email,
          full_name,
          commission_type,
          commission_value,
        },
      });
    }

    // 2️⃣ Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // 3️⃣ Get MARKETER role id
    const [roleRows] = await connection.query(
      `SELECT role_id FROM roles WHERE role_name = 'marketer'`
    );

    if ((roleRows as any[]).length === 0) {
      throw new Error("MARKETER role not found");
    }

    const marketerRoleId = (roleRows as any[])[0].role_id;

    // 4️⃣ Create user
    // NOTE: RETURNING user_id removed — generate the UUID app-side first,
    // same pattern as registerUser/newCreateCustomer earlier
    const userId = crypto.randomUUID();

    await connection.query(
      `
      INSERT INTO users (
        user_id,
        email,
        full_name,
        password_hash,
        role_id,
        is_verified
      )
      VALUES (?, ?, ?, ?, ?, true)
      `,
      [userId, email, full_name, passwordHash, marketerRoleId]
    );

    // 5️⃣ Create marketer profile
    // NOTE: marketer_id also needs app-side generation now
    await connection.query(
      `
      INSERT INTO marketers (
        marketer_id,
        user_id,
        commission_type,
        commission_value,
        created_by
      )
      VALUES (?, ?, ?, ?, ?)
      `,
      [crypto.randomUUID(), userId, commission_type, commission_value, adminId]
    );

    await connection.commit();

    return res.status(201).json({
      message: "Marketer created successfully",
      data: {
        user_id: userId,
        email,
        full_name,
        commission_type,
        commission_value,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);

    return res.status(500).json({
      message: "Failed to create marketer",
    });
  } finally {
    connection.release();
  }
};


export const getMarketers = async (req: Request, res: Response) => {
  try {
    const {
      page = "1",
      limit = "10",
      email,
      commission_type,
      created_by,
    } = req.query;

    const pageNumber = Math.max(Number(page), 1);
    const pageSize = Math.max(Number(limit), 1);
    const offset = (pageNumber - 1) * pageSize;

    let baseQuery = `
      FROM marketers m
      JOIN users u ON u.user_id = m.user_id
      JOIN users admin ON admin.user_id = m.created_by
      WHERE 1=1 AND m.status = 'active'
    `;

    const values: any[] = [];

    // NOTE: no more `index` counter needed — MySQL's ? is purely positional
    if (email) {
      // NOTE: ILIKE -> LIKE
      baseQuery += ` AND u.email LIKE ?`;
      values.push(`%${email}%`);
    }

    if (commission_type) {
      baseQuery += ` AND m.commission_type = ?`;
      values.push(commission_type);
    }

    if (created_by) {
      baseQuery += ` AND m.created_by = ?`;
      values.push(created_by);
    }

    // total count
    // NOTE: added "AS count" alias — MySQL names an unaliased COUNT(*) as
    // literally "COUNT(*)", not "count" like Postgres does. Without this,
    // countResult.rows[0].count would be undefined and Number(undefined)
    // silently produces NaN, breaking pagination with no visible error.
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS count ${baseQuery}`,
      values
    );
    const total = Number((countRows as any[])[0].count);

    // data
    // NOTE: LIMIT/OFFSET no longer need numbered placeholders based on
    // `index` — just two more `?` at the end, values pushed in order
    const dataQuery = `
      SELECT
        m.marketer_id,
        m.commission_type,
        m.commission_value,
        m.status,
        m.created_at,
        u.user_id,
        u.email,
        u.full_name,
        admin.full_name AS created_by_name,
        admin.email AS created_by_email
      ${baseQuery}
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `;

    values.push(pageSize, offset);

    const [rows] = await pool.query(dataQuery, values);

    res.status(200).json({
      page: pageNumber,
      limit: pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      data: rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch marketers",
    });
  }
};

// controllers/marketer.controller.ts
export const searchMarketersByName = async (req: Request, res: Response) => {
  // 1. Default to empty string to allow initial loading
  const q = req.query.q as string || "";

  try {
    // NOTE: ILIKE -> LIKE, and '%' || $1 || '%' -> CONCAT('%', ?, '%').
    // Postgres's || is string concatenation; MySQL's default sql_mode
    // treats || as logical OR instead, so it silently means something
    // completely different if left as-is — CONCAT() is the safe,
    // unambiguous replacement.
    const queryText = `
      SELECT 
        m.marketer_id,
        u.full_name
      FROM marketers m
      JOIN users u ON u.user_id = m.user_id
      WHERE m.status = 'active'
        ${q ? "AND u.full_name LIKE CONCAT('%', ?, '%')" : ""}
      ORDER BY u.full_name
      LIMIT 10
    `;

    const values = q ? [q] : [];
    // NOTE: mysql2 returns [rows, fields], not { rows }
    const [rows] = await pool.query(queryText, values);

    // 3. Return raw rows for frontend mapping
    res.status(200).json(rows);
  } catch (error) {
    console.error("Marketer Search Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const softDeleteMarketer = async (req: Request, res: Response) => {
  const connection = await pool.getConnection(); // NOTE: pool.connect() -> pool.getConnection()

  try {
    const { marketerId } = req.params;

    if (!marketerId) {
      return res.status(400).json({
        message: "Marketer ID is required",
      });
    }

    await connection.beginTransaction();

    // 1️⃣ Get marketer & linked user
    // NOTE: $1 -> ?
    const [marketerRows] = await connection.query(
      `
      SELECT m.marketer_id, u.user_id
      FROM marketers m
      JOIN users u ON u.user_id = m.user_id
      WHERE m.marketer_id = ?
        AND m.status != 'deleted'
      `,
      [marketerId]
    );

    // NOTE: rowCount -> array length check
    if ((marketerRows as any[]).length === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "Marketer not found or already deleted",
      });
    }

    const { user_id } = (marketerRows as any[])[0];

    // 2️⃣ Soft delete marketer
    await connection.query(
      `
      UPDATE marketers
      SET status = 'deleted'
      WHERE marketer_id = ?
      `,
      [marketerId]
    );

    // 3️⃣ Soft delete user
    // NOTE: CURRENT_TIMESTAMP works identically in MySQL/MariaDB, no change
    // needed here
    await connection.query(
      `
      UPDATE users
      SET status = 'deleted',
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
      `,
      [user_id]
    );

    await connection.commit();

    return res.status(200).json({
      message: "Marketer deleted successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);

    return res.status(500).json({
      message: "Failed to delete marketer",
    });
  } finally {
    connection.release();
  }
};


export const updateMarketerCommission = async (
  req: Request,
  res: Response
) => {
  const connection = await pool.getConnection(); // NOTE: pool.connect() -> pool.getConnection()

  try {
    const { marketerId } = req.params;
    const { commission_type, commission_value } = req.body;

    if (!marketerId) {
      return res.status(400).json({
        message: "Marketer ID is required",
      });
    }

    if (
      commission_type === undefined &&
      commission_value === undefined
    ) {
      return res.status(400).json({
        message: "Nothing to update",
      });
    }

    // Optional validations
    if (
      commission_type &&
      !["percentage", "fixed"].includes(commission_type)
    ) {
      return res.status(400).json({
        message: "Invalid commission type",
      });
    }

    if (
      commission_value !== undefined &&
      (isNaN(commission_value) || commission_value <= 0)
    ) {
      return res.status(400).json({
        message: "Invalid commission value",
      });
    }

    await connection.beginTransaction();

    // 1️⃣ Check marketer exists & active
    // NOTE: $1 -> ?
    const [marketerCheckRows] = await connection.query(
      `
      SELECT marketer_id
      FROM marketers
      WHERE marketer_id = ?
        AND status != 'deleted'
      `,
      [marketerId]
    );

    // NOTE: rowCount -> array length check
    if ((marketerCheckRows as any[]).length === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "Marketer not found or deleted",
      });
    }

    // 2️⃣ Build dynamic update
    // NOTE: no more `index` counter needed — MySQL's ? placeholders are
    // purely positional, so this dynamic query builder gets simpler, same
    // as the updateCustomer conversion earlier.
    const fields: string[] = [];
    const values: any[] = [];

    if (commission_type !== undefined) {
      fields.push(`commission_type = ?`);
      values.push(commission_type);
    }

    if (commission_value !== undefined) {
      fields.push(`commission_value = ?`);
      values.push(commission_value);
    }

    values.push(marketerId);

    const updateQuery = `
      UPDATE marketers
      SET ${fields.join(", ")}
      WHERE marketer_id = ?
    `;

    await connection.query(updateQuery, values);

    await connection.commit();

    return res.status(200).json({
      message: "Commission updated successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);

    return res.status(500).json({
      message: "Failed to update commission",
    });
  } finally {
    connection.release();
  }
};

export const hardDeleteMarketer = async (req: Request, res: Response) => {
  const connection = await pool.getConnection();

  try {
    const { marketerId } = req.params;

    if (!marketerId) {
      return res.status(400).json({
        message: "Marketer ID is required",
      });
    }

    await connection.beginTransaction();

    // 1️⃣ Get marketer & linked user
    const [marketerRows] = await connection.query(
      `
      SELECT m.marketer_id, u.user_id
      FROM marketers m
      JOIN users u ON u.user_id = m.user_id
      WHERE m.marketer_id = ?
      `,
      [marketerId]
    );

    if ((marketerRows as any[]).length === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "Marketer not found",
      });
    }

    const { user_id } = (marketerRows as any[])[0];

    // 2️⃣ Nullify marketer_id on customers referencing this marketer
    await connection.query(
      `
      UPDATE customers
      SET marketer_id = NULL
      WHERE marketer_id = ?
      `,
      [marketerId]
    );

    // 3️⃣ Delete marketer commissions
    await connection.query(
      `
      DELETE FROM marketer_commissions
      WHERE marketer_id = ?
      `,
      [marketerId]
    );

    // 4️⃣ Delete marketer record
    await connection.query(
      `
      DELETE FROM marketers
      WHERE marketer_id = ?
      `,
      [marketerId]
    );

    // 5️⃣ Delete the linked user
    await connection.query(
      `
      DELETE FROM users
      WHERE user_id = ?
      `,
      [user_id]
    );

    await connection.commit();

    return res.status(200).json({
      message: "Marketer permanently deleted",
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);

    return res.status(500).json({
      message: "Failed to permanently delete marketer",
    });
  } finally {
    connection.release();
  }
};