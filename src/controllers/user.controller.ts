import { Request, Response } from "express";
import { pool } from "../config/db";
import bcrypt from "bcryptjs";


class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

const ALLOWED_ACCOUNT_STATUSES = ["active", "suspended"] as const;
type AccountStatus = (typeof ALLOWED_ACCOUNT_STATUSES)[number];

interface UpdateBusinessRolesBody {
  status?: AccountStatus;
  is_marketer?: boolean;
  is_customer?: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export const getUsers = async (req: Request, res: Response) => {
  try {
    const {
      page = "1",
      limit = "10",
      role,
      search,
    } = req.query;

    const pageNumber = Math.max(Number(page), 1);
    const pageSize = Math.max(Number(limit), 1);
    const offset = (pageNumber - 1) * pageSize;

    let baseQuery = `
      FROM users u
      JOIN roles r ON r.role_id = u.role_id
      WHERE r.role_group = 'internal'
    `;

    const values: any[] = [];

    // 🔎 Search
    if (search) {
      baseQuery += `
        AND (
          u.email LIKE ?
          OR u.full_name LIKE ?
        )
      `;
      values.push(`%${search}%`, `%${search}%`);
    }

    // 🎭 Optional role filter (admin/staff only)
    if (role) {
      baseQuery += ` AND r.role_name = ?`;
      values.push(role);
    }

    // 🔢 Count
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS count ${baseQuery}`,
      values
    );
    const total = Number((countRows as any[])[0].count);

    // 📄 Data
    const dataQuery = `
      SELECT
        u.user_id,
        u.email,
        u.full_name,
        u.is_verified,
        u.created_at,
        u.last_login_at,
        u.status,
        r.role_name
      ${baseQuery}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const dataValues = [...values, pageSize, offset];

    const [rows] = await pool.query(dataQuery, dataValues);

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
      message: "Failed to fetch users",
    });
  }
};




export const updateUserByAdmin = async (req: Request, res: Response) => {
  const connection = await pool.getConnection();

  try {
    const { userId } = req.params;
    const { full_name, role_name, status, password } = req.body;

    if (!userId) {
      connection.release();
      return res.status(400).json({ message: "User ID is required" });
    }

    await connection.beginTransaction();

    // 1. Handle Role Update if role_name is provided
    if (role_name) {
      const [roleRows] = await connection.query(
        "SELECT role_id FROM roles WHERE role_name = ? AND role_group = 'internal'",
        [role_name.toLowerCase()]
      );

      const roleResult = roleRows as any[];

      if (roleResult.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({ message: "Invalid internal role name. It should be Admin or staff" });
      }

      const newRoleId = roleResult[0].role_id;

      // Wipe old system roles and insert new one
      await connection.query(
        `DELETE FROM user_roles WHERE user_id = ? AND role_id IN 
         (SELECT role_id FROM roles WHERE role_group = 'internal')`,
        [userId]
      );
      await connection.query(
        "INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)",
        [userId, newRoleId]
      );
      // Sync the snapshot column on users table
      await connection.query("UPDATE users SET role_id = ? WHERE user_id = ?", [newRoleId, userId]);
    }

    // 2. Update dynamic profile fields
    const fields: string[] = [];
    const values: any[] = [];

    const updates: any = { full_name, status };

    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      fields.push(`password_hash = ?`);
      values.push(hashedPassword);
    }

    if (fields.length > 0) {
      values.push(userId);
      await connection.query(
        `UPDATE users SET ${fields.join(", ")}, updated_at = now() WHERE user_id = ?`,
        values
      );
    }

    await connection.commit();
    res.status(200).json({ message: "User updated successfully" });
  } catch (error: any) {
    await connection.rollback();
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};

export const updateUserRoles = async (req: Request, res: Response) => {
  const connection = await pool.getConnection();

  try {
    const { userId } = req.params;
    const { add_roles = [], remove_roles = [] } = req.body;

    if (!userId) {
      connection.release();
      return res.status(400).json({ message: "User ID required" });
    }

    await connection.beginTransaction();

    // 🔴 Remove roles
    if (remove_roles.length > 0) {
      await connection.query(
        `DELETE FROM user_roles
         WHERE user_id = ? AND role_id IN (?)`,
        [userId, remove_roles]
      );

      // 🧠 Domain rule → if marketer removed → deactivate marketer
      const [marketerRoleRows] = await connection.query(
        `SELECT role_id FROM roles WHERE role_name = 'marketer'`
      );

      const marketerRole = marketerRoleRows as any[];

      if (marketerRole.length > 0) {
        const marketerRoleId = marketerRole[0].role_id;

        if (remove_roles.includes(marketerRoleId)) {
          await connection.query(
            `UPDATE marketers SET status = 'inactive' WHERE user_id = ?`,
            [userId]
          );
        }
      }
    }

    // 🟢 Add roles
    if (add_roles.length > 0) {
      const insertValues: any[] = [];
      const placeholders = add_roles
        .map((roleId: string) => {
          insertValues.push(userId, roleId);
          return "(?, ?)";
        })
        .join(", ");

      await connection.query(
        `INSERT IGNORE INTO user_roles (user_id, role_id)
         VALUES ${placeholders}`,
        insertValues
      );
    }

    // 🔵 Recalculate highest priority role
    const [highestRoleRows] = await connection.query(
      `
      SELECT ur.role_id
      FROM user_roles ur
      JOIN roles r ON r.role_id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.priority DESC
      LIMIT 1
      `,
      [userId]
    );

    const highestRole = highestRoleRows as any[];

    if (highestRole.length === 0) {
      throw new Error("User must have at least one role");
    }

    const primaryRoleId = highestRole[0].role_id;

    // 🟣 Update users.role_id
    await connection.query(
      `UPDATE users SET role_id = ? WHERE user_id = ?`,
      [primaryRoleId, userId]
    );

    await connection.commit();

    return res.status(200).json({
      message: "User roles updated successfully",
      primary_role: primaryRoleId,
    });

  } catch (error: any) {
    await connection.rollback();
    console.error(error);
    return res.status(500).json({
      message: "Failed to update roles",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};



export const softDeleteUser = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    // check if user exists & not already deleted
    const [userRows] = await pool.query(
      `
      SELECT user_id, status
      FROM users
      WHERE user_id = ?
      `,
      [userId]
    );

    const userCheck = userRows as any[];

    if (userCheck.length === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (userCheck[0].status === "deleted") {
      return res.status(400).json({
        message: "User is already deleted",
      });
    }

    // soft delete
    await pool.query(
      `
      UPDATE users
      SET status = 'deleted',
          updated_at = NOW()
      WHERE user_id = ?
      `,
      [userId]
    );

    res.status(200).json({
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to delete user",
    });
  }
};


export const hardDeleteUser = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const [result] = await pool.query(
      `
      DELETE FROM users
      WHERE user_id = ?
      `,
      [userId]
    );

    const affectedRows = (result as any).affectedRows;

    if (affectedRows === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    res.status(200).json({
      message: "User permanently deleted successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to delete user",
    });
  }
};

export const updateBusinessRoles = async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { status, is_marketer, is_customer }: UpdateBusinessRolesBody =
    req.body;

  try {
    // ── 1. Input validation (no DB connection needed yet) ──────────────
    if (!userId || !UUID_RE.test(userId as string)) {
      throw new AppError(400, "Invalid user id");
    }

    if (status !== undefined && !ALLOWED_ACCOUNT_STATUSES.includes(status)) {
      throw new AppError(
        400,
        `Invalid status. Allowed values: ${ALLOWED_ACCOUNT_STATUSES.join(", ")}`
      );
    }

    if (is_marketer !== undefined && typeof is_marketer !== "boolean") {
      throw new AppError(400, "is_marketer must be a boolean");
    }

    if (is_customer !== undefined && typeof is_customer !== "boolean") {
      throw new AppError(400, "is_customer must be a boolean");
    }

    if (
      status === undefined &&
      is_marketer === undefined &&
      is_customer === undefined
    ) {
      throw new AppError(400, "No changes provided");
    }

    // Prevent an admin/staff from locking themselves out
    if (status === "suspended" && req.user?.user_id === userId) {
      throw new AppError(400, "You cannot suspend your own account");
    }

    // ── 2. Acquire connection + transaction ─────────────────────────────
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Lock the target user row and confirm it exists
      const [userRows] = await connection.query(
        `SELECT user_id, status FROM users WHERE user_id = ? FOR UPDATE`,
        [userId]
      );
      const targetUser = (userRows as any[])[0];

      if (!targetUser) {
        throw new AppError(404, "User not found");
      }

      if (targetUser.status === "deleted") {
        throw new AppError(
          400,
          "This user is deleted and cannot be modified here"
        );
      }

      // Role definitions
      const [roleRows] = await connection.query(
        `SELECT role_id, role_name FROM roles
         WHERE role_name IN ('marketer', 'customer') AND role_group = 'external'`
      );
      const roles = roleRows as any[];

      const marketerRole = roles.find((r) => r.role_name === "marketer");
      const customerRole = roles.find((r) => r.role_name === "customer");

      if (!marketerRole || !customerRole) {
        throw new AppError(
          500,
          "Marketer/Customer roles not configured properly"
        );
      }

      // Current external roles
      const [currentRows] = await connection.query(
        `SELECT role_id FROM user_roles WHERE user_id = ? AND role_id IN (?, ?)`,
        [userId, marketerRole.role_id, customerRole.role_id]
      );
      const currentRoleIds = (currentRows as any[]).map((r) => r.role_id);

      const hasMarketer = currentRoleIds.includes(marketerRole.role_id);
      const hasCustomer = currentRoleIds.includes(customerRole.role_id);

      const toAdd: { role_id: string; role_name: string }[] = [];
      const toRemove: { role_id: string; role_name: string }[] = [];

      if (is_marketer === true && !hasMarketer) toAdd.push(marketerRole);
      if (is_marketer === false && hasMarketer) toRemove.push(marketerRole);

      if (is_customer === true && !hasCustomer) toAdd.push(customerRole);
      if (is_customer === false && hasCustomer) toRemove.push(customerRole);

      // ── Remove roles ───────────────────────────────────────────────
      if (toRemove.length) {
        const removeIds = toRemove.map((r) => r.role_id);
        await connection.query(
          `DELETE FROM user_roles WHERE user_id = ? AND role_id IN (?)`,
          [userId, removeIds]
        );

        for (const role of toRemove) {
          if (role.role_name === "marketer") {
            await connection.query(
              `UPDATE marketers SET status = 'inactive' WHERE user_id = ?`,
              [userId]
            );
          }
          if (role.role_name === "customer") {
            await connection.query(
              `UPDATE customers SET status = 'inactive' WHERE user_id = ?`,
              [userId]
            );
          }
        }
      }

      // ── Add roles ────────────────────────────────────────────────
      if (toAdd.length) {
        const insertValues: any[] = [];
        const placeholders = toAdd
          .map((role) => {
            insertValues.push(userId, role.role_id);
            return "(?, ?)";
          })
          .join(", ");

        await connection.query(
          `INSERT IGNORE INTO user_roles (user_id, role_id) VALUES ${placeholders}`,
          insertValues
        );

        for (const role of toAdd) {
          if (role.role_name === "marketer") {
            const [existsRows] = await connection.query(
              `SELECT 1 FROM marketers WHERE user_id = ?`,
              [userId]
            );

            if ((existsRows as any[]).length === 0) {
              const newMarketerId = crypto.randomUUID();
              await connection.query(
                `INSERT INTO marketers (marketer_id, user_id, commission_value, created_by)
                 VALUES (?, ?, 0, ?)`,
                [newMarketerId, userId, req.user?.user_id]
              );
            } else {
              // Only reactivate a role we previously deactivated —
              // don't clobber a status set for an unrelated reason.
              await connection.query(
                `UPDATE marketers SET status = 'active'
                 WHERE user_id = ? AND status = 'inactive'`,
                [userId]
              );
            }
          }

          if (role.role_name === "customer") {
            const [existsRows] = await connection.query(
              `SELECT 1 FROM customers WHERE user_id = ?`,
              [userId]
            );

            if ((existsRows as any[]).length === 0) {
              const newCustomerId = crypto.randomUUID();
              await connection.query(
                `INSERT INTO customers (customer_id, user_id, created_by)
                 VALUES (?, ?, ?)`,
                [newCustomerId, userId, req.user?.user_id]
              );
            } else {
              await connection.query(
                `UPDATE customers SET status = 'active'
                 WHERE user_id = ? AND status = 'inactive'`,
                [userId]
              );
            }
          }
        }
      }

      // ── Account-level status (authoritative for auth) ──────────────
      if (status) {
        await connection.query(`UPDATE users SET status = ? WHERE user_id = ?`, [
          status,
          userId,
        ]);
      }

      await connection.commit();

      return res.status(200).json({
        message: "Business roles updated successfully",
      });
    } catch (error) {
      await connection.rollback();
      throw error; // re-throw so the outer catch formats the response
    } finally {
      connection.release();
    }
  } catch (error: any) {
    if (!(error instanceof AppError)) {
      console.error("updateBusinessRoles failed:", error);
    }
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return res.status(statusCode).json({
      message:
        statusCode === 500 ? "Failed to update business roles" : error.message,
    });
  }
};

export const getMarketParticipants = async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "10", search } = req.query;

    const user_id = req.user?.user_id;
    const role = req.user?.role;
    const isAdmin = role === "admin";

    const pageNumber = Math.max(Number(page), 1);
    const pageSize = Math.max(Number(limit), 1);
    const offset = (pageNumber - 1) * pageSize;

    const values: any[] = [];

    let baseQuery = `
      FROM users u
      LEFT JOIN marketers m ON m.user_id = u.user_id
      LEFT JOIN customers c ON c.user_id = u.user_id
      WHERE u.status != 'deleted'
      AND (m.marketer_id IS NOT NULL OR c.customer_id IS NOT NULL)
    `;

    // 🔐 Staff filter — customers and marketers they created
    if (!isAdmin) {
      baseQuery += ` AND (c.created_by = ? OR m.created_by = ?)`;
      values.push(user_id, user_id);
    }

    // 🔍 Search
    if (search) {
      baseQuery += `
        AND (
          u.email LIKE ?
          OR u.full_name LIKE ?
        )
      `;
      values.push(`%${search}%`, `%${search}%`);
    }

    // 📊 Total count
    const [countRows] = await pool.query(
      `SELECT COUNT(DISTINCT u.user_id) AS count ${baseQuery}`,
      values
    );

    const total = Number((countRows as any[])[0].count);

    // 📦 Data query
    const dataQuery = `
      SELECT 
          u.user_id,
          u.full_name,
          u.email,
          u.status AS user_status,

          m.marketer_id,
          m.commission_type,
          m.commission_value,
          m.status AS marketer_status,

          c.customer_id,
          c.phone_number,
          c.city,
          c.status AS customer_status

      ${baseQuery}

      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const dataValues = [...values, pageSize, offset];

    const [rows] = await pool.query(dataQuery, dataValues);

    // 🧠 Format response
    const formatted = (rows as any[]).map(user => ({
      user_id: user.user_id,
      full_name: user.full_name,
      email: user.email,
      status: user.user_status,

      roles: {
        is_marketer: user.marketer_status === 'active',
        is_customer: user.customer_status === 'active'
      },

      marketer: user.marketer_id
        ? {
          marketer_id: user.marketer_id,
          commission_type: user.commission_type,
          commission_value: user.commission_value,
          status: user.marketer_status
        }
        : null,

      customer: user.customer_id
        ? {
          customer_id: user.customer_id,
          phone_number: user.phone_number,
          city: user.city,
          status: user.customer_status
        }
        : null
    }));

    res.status(200).json({
      page: pageNumber,
      limit: pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      data: formatted
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch market participants"
    });
  }
};