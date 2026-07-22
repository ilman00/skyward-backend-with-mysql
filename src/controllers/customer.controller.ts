import { Request, Response } from "express";
import { pool } from "../config/db";


/* =========================
   HELPER — Gap Detection
========================== */
function getUnpaidMonths(
  closingDate: Date,
  monthlyRent: number,
  paidMonths: Set<string>
): { month: string; amount: number }[] {
  const unpaid: { month: string; amount: number }[] = [];

  // Start from the month AFTER closing (first rent is due next month)
  const cursor = new Date(closingDate.getFullYear(), closingDate.getMonth() + 1, 1);
  const today = new Date();
  const currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  while (cursor <= currentMonth) {
    const monthStr = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;

    if (!paidMonths.has(monthStr)) {
      unpaid.push({ month: monthStr, amount: monthlyRent });
    }

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return unpaid;
}

// export const createCustomer = async (req: Request, res: Response) => {
//   const client = await pool.connect();

//   try {
//     const {
//       full_name,
//       email,
//       password,
//       contact_number,
//       cnic,
//       address,
//       city,
//     } = req.body;

//     const adminId = req.user!.user_id;

//     if (!full_name || !email || !password) {
//       return res.status(400).json({
//         message: "Full name, mail and password are required",
//       });
//     }

//     await client.query("BEGIN");

//     // 1️⃣ Check existing user
//     const existingUser = await client.query(
//       `SELECT 1 FROM users WHERE email = $1`,
//       [email]
//     );

//     if (existingUser.rowCount) {
//       await client.query("ROLLBACK");
//       return res.status(409).json({
//         message: "User with this email already exists",
//       });
//     }

//     // 2️⃣ Get CUSTOMER role id (lowercase role name)
//     const roleResult = await client.query(
//       `SELECT role_id FROM roles WHERE role_name = 'customer'`
//     );

//     if (!roleResult.rowCount) {
//       throw new Error("Customer role not found");
//     }

//     const customerRoleId = roleResult.rows[0].role_id;

//     // 3️⃣ Hash password
//     const passwordHash = await bcrypt.hash(password, 10);

//     // 4️⃣ Create user
//     const userResult = await client.query(
//       `
//       INSERT INTO users (
//         full_name,
//         email,
//         password_hash,
//         role_id,
//         is_verified
//       )
//       VALUES ($1, $2, $3, $4, true)
//       RETURNING user_id
//       `,
//       [full_name, email, passwordHash, customerRoleId]
//     );

//     const userId = userResult.rows[0].user_id;

//     // 5️⃣ Create customer profile
//     await client.query(
//       `
//       INSERT INTO customers (
//         user_id,
//         contact_number,
//         cnic,
//         address,
//         city,
//         created_by
//       )
//       VALUES ($1, $2, $3, $4, $5, $6)
//       `,
//       [
//         userId,
//         contact_number || null,
//         cnic || null,
//         address || null,
//         city || null,
//         adminId,
//       ]
//     );

//     await client.query("COMMIT");

//     res.status(201).json({
//       message: "Customer created successfully",
//       data: {
//         user_id: userId,
//         email,
//         role: "customer",
//         is_verified: true,
//       },
//     });
//   } catch (error) {
//     await client.query("ROLLBACK");
//     console.error(error);

//     res.status(500).json({
//       message: "Failed to create customer",
//     });
//   } finally {
//     client.release();
//   }
// };



export const newCreateCustomer = async (req: Request, res: Response) => {
  const connection = await pool.getConnection(); // NOTE: pool.connect() -> pool.getConnection()

  try {
    const {
      full_name,
      email,

      contact_number,
      city,
      address,
      cnic,

      father_name,
      bank_name,
      account_name,
      account_number,

      heir,
      marketer_id
    } = req.body;

    const creator_id = req.user!.user_id;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    // NOTE: BEGIN as a raw string -> beginTransaction() method
    await connection.beginTransaction();

    // ✅ Get customer role
    const [roleRows] = await connection.query(
      `SELECT role_id FROM roles WHERE role_name = 'customer' LIMIT 1`
    );

    // NOTE: rowCount -> check array length instead
    if ((roleRows as any[]).length === 0) {
      throw new Error("Customer role not found");
    }

    const customerRoleId = (roleRows as any[])[0].role_id;

    // ✅ Check if user exists
    // NOTE: $1 -> ?
    const [existingUserRows] = await connection.query(
      `SELECT user_id FROM users WHERE email = ? LIMIT 1`,
      [email]
    );

    let userId: string;
    let isNewUser = false;

    if ((existingUserRows as any[]).length > 0) {
      userId = (existingUserRows as any[])[0].user_id;
    } else {
      if (!full_name) {
        // NOTE: this early return happens *inside* an open transaction —
        // same bug existed in your Postgres version (no ROLLBACK called
        // before returning here), just flagging it since it's worth fixing
        // now that we're touching this code. Consider rolling back +
        // releasing before this return.
        return res.status(400).json({
          success: false,
          message: "full_name required for new user"
        });
      }

      // NOTE: user_id was DB-generated via RETURNING in Postgres.
      // No RETURNING in MySQL, so generate the UUID in Node first,
      // then insert it explicitly.
      userId = crypto.randomUUID();

      await connection.query(
        `INSERT INTO users (user_id, full_name, email, role_id)
         VALUES (?, ?, ?, ?)`,
        [userId, full_name, email, customerRoleId]
      );

      isNewUser = true;
    }

    // ✅ Assign role in junction table
    // NOTE: Postgres `ON CONFLICT DO NOTHING` -> MySQL `INSERT IGNORE`.
    // This works here because user_roles has a composite PRIMARY KEY on
    // (user_id, role_id), so a duplicate insert triggers a primary-key
    // violation, which INSERT IGNORE silently swallows — matching the
    // "do nothing on conflict" behavior. Careful with INSERT IGNORE in
    // general though: it also silently swallows *other* warnings/errors
    // (like data truncation), not just key conflicts, so it's a slightly
    // blunter tool than Postgres's targeted ON CONFLICT.
    await connection.query(
      `INSERT IGNORE INTO user_roles (user_id, role_id)
       VALUES (?, ?)`,
      [userId, customerRoleId]
    );

    // ✅ Ensure customer profile does not already exist
    const [existingCustomerRows] = await connection.query(
      `SELECT customer_id FROM customers WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    let customerId: string;

    if ((existingCustomerRows as any[]).length > 0) {
      customerId = (existingCustomerRows as any[])[0].customer_id;
    } else {
      // NOTE: same RETURNING fix as above — generate customer_id in Node
      customerId = crypto.randomUUID();

      await connection.query(
        `INSERT INTO customers (
          customer_id,
          user_id,
          phone_number,
          city,
          address,
          cnic,
          father_name,
          marketer_id,
          created_by
        )
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          customerId,
          userId,
          contact_number || null,
          city || null,
          address || null,
          cnic || null,
          father_name || null,
          marketer_id || null,
          creator_id
        ]
      );
    }

    // ✅ Insert bank details if provided
    if (bank_name || account_name || account_number) {
      // NOTE: bank_account_id also needs app-side generation now
      await connection.query(
        `INSERT INTO customer_bank_accounts
         (bank_account_id, customer_id, bank_name, account_name, account_number)
         VALUES (?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          customerId,
          bank_name || null,
          account_name || null,
          account_number || null
        ]
      );
    }

    // ✅ Insert heir if provided
    if (heir && heir.full_name) {
      // NOTE: same — customer_heir_id generated app-side
      await connection.query(
        `INSERT INTO customer_heirs
        (customer_heir_id, customer_id, full_name, cnic, phone_number)
        VALUES (?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          customerId,
          heir.full_name,
          heir.cnic || null,
          heir.phone_number || null
        ]
      );
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: isNewUser
        ? "Customer created with new user"
        : "Customer profile added to existing user",
      data: {
        customer_id: customerId,
        user_id: userId,
        is_new_user: isNewUser
      }
    });

  } catch (error: any) {
    await connection.rollback();

    console.error("Create customer error:", error);

    // NOTE: error.detail was a pg-specific property on constraint violation
    // errors (e.g. "Key (email)=(...) already exists."). mysql2 doesn't
    // have `.detail` — the closest equivalent is `error.sqlMessage`, which
    // has different wording. Fall back to error.message or a generic string.
    res.status(500).json({
      success: false,
      message: error.sqlMessage || error.message || "Failed to create customer"
    });

  } finally {
    connection.release();
  }
};


export const updateCustomer = async (req: Request, res: Response) => {
  const connection = await pool.getConnection(); // NOTE: pool.connect() -> pool.getConnection()

  try {
    const { userId } = req.params;

    const {
      role,
      cnic,
      address,
      status,
    } = req.body;

    if (!userId) {
      return res.status(400).json({
        message: "userId param is required",
      });
    }

    await connection.beginTransaction();

    /* -----------------------------
       1️⃣ Check user exists
    ------------------------------*/
    // NOTE: $1 -> ?
    const [userCheckRows] = await connection.query(
      `SELECT user_id FROM users WHERE user_id = ?`,
      [userId]
    );

    // NOTE: rowCount -> array length check
    if ((userCheckRows as any[]).length === 0) {
      await connection.rollback();
      return res.status(404).json({
        message: "User not found",
      });
    }

    /* -----------------------------
       2️⃣ Update role (if provided)
    ------------------------------*/
    if (role) {
      const [roleRows] = await connection.query(
        `SELECT role_id FROM roles WHERE role_name = ?`,
        [role]
      );

      if ((roleRows as any[]).length === 0) {
        throw new Error("Invalid role");
      }

      // NOTE: now() works fine in MySQL/MariaDB too — function names are
      // case-insensitive, so no change needed here.
      await connection.query(
        `
        UPDATE users
        SET role_id = ?,
            updated_at = now()
        WHERE user_id = ?
        `,
        [(roleRows as any[])[0].role_id, userId]
      );
    }

    /* -----------------------------
       3️⃣ Update user status (if provided)
    ------------------------------*/
    if (status) {
      await connection.query(
        `
        UPDATE users
        SET status = ?,
            updated_at = now()
        WHERE user_id = ?
        `,
        [status, userId]
      );
    }

    /* -----------------------------
       4️⃣ Update customer table fields
    ------------------------------*/
    const customerUpdates: string[] = [];
    const values: any[] = [];

    // NOTE: Postgres used numbered placeholders ($1, $2...) built up with an
    // incrementing `idx`, since it requires each parameter to be numbered
    // and matched positionally by number. MySQL's `?` placeholders are just
    // positional by order of appearance — no numbering needed, so `idx` can
    // be dropped entirely. This actually simplifies the code.
    if (cnic !== undefined) {
      customerUpdates.push(`cnic = ?`);
      values.push(cnic);
    }

    if (address !== undefined) {
      customerUpdates.push(`address = ?`);
      values.push(address);
    }

    if (status !== undefined) {
      customerUpdates.push(`status = ?`);
      values.push(status);
    }

    if (customerUpdates.length) {
      customerUpdates.push(`updated_at = now()`);

      await connection.query(
        `
        UPDATE customers
        SET ${customerUpdates.join(", ")}
        WHERE user_id = ?
        `,
        [...values, userId]
      );
    }

    await connection.commit();

    res.status(200).json({
      message: "Customer updated successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);

    res.status(500).json({
      message: "Failed to update customer",
    });
  } finally {
    connection.release();
  }
};


export const getAllCustomers = async (req: Request, res: Response) => {
  const connection = await pool.getConnection(); // NOTE: pool.connect() -> pool.getConnection()

  try {
    const { status, search } = req.query;
    const user = req.user as any;

    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
    const offset = (page - 1) * limit;

    let conditions: string[] = [];
    let values: any[] = [];

    conditions.push(`c.status != 'deleted'`);

    /* -----------------------------
       Role-based access
    ------------------------------ */
    // NOTE: no more idx counter needed — MySQL's `?` placeholders are
    // purely positional (matched by order of appearance), unlike Postgres's
    // numbered $1/$2/etc. This removes an entire class of bookkeeping.
    if (user.role === "staff") {
      conditions.push(`c.created_by = ?`);
      values.push(user.user_id);
    }

    if (status) {
      conditions.push(`c.status = ?`);
      values.push(status);
    }

    if (search) {
      // NOTE #1: ILIKE -> LIKE. MySQL/MariaDB has no ILIKE. Case-sensitivity
      // then depends on the column's collation — most default collations
      // (e.g. utf8mb4_general_ci, utf8mb4_unicode_ci) are already
      // case-insensitive, so plain LIKE should behave the same as ILIKE
      // did. If your columns use a case-sensitive collation (anything
      // ending in _bin, or _cs in newer MariaDB), wrap both sides in
      // LOWER() instead to force insensitivity.
      //
      // NOTE #2: this is the big one — Postgres reused the SAME numbered
      // placeholder ($4) five times in one query, which Postgres allows.
      // MySQL's `?` is strictly positional: each `?` consumes the NEXT
      // value in the array, so a placeholder appearing 5 times needs the
      // value pushed 5 times, once per occurrence, in the exact order they
      // appear in the SQL text below.
      const likeTerm = `%${search}%`;
      conditions.push(`
        (
          u.email       LIKE ?
          OR u.full_name      LIKE ?
          OR c.contact_number LIKE ?
          OR c.cnic           LIKE ?
          OR s.smd_code       LIKE ?
        )
      `);
      values.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    /* -----------------------------
       Total count
    ------------------------------ */
    // NOTE: removed '::int' cast — not valid MySQL syntax, and unnecessary
    // since COUNT() already returns an integer.
    const countQuery = `
      SELECT COUNT(DISTINCT c.customer_id) AS total
      FROM customers c
      JOIN users u ON u.user_id = c.user_id
      LEFT JOIN smd_closings sc
        ON sc.customer_id = c.customer_id
        AND sc.status = 'active'
      LEFT JOIN smds s
        ON s.smd_id = sc.smd_id
      ${whereClause}
    `;

    const [countRows] = await connection.query(countQuery, values);
    const total = (countRows as any[])[0].total;

    /* -----------------------------
       Paginated customer rows (no SMD aggregation here anymore)
    ------------------------------ */
    // NOTE: we still LEFT JOIN smd_closings/smds here because the search
    // filter needs to match against s.smd_code — but we GROUP BY
    // c.customer_id to collapse any duplicate rows caused by a customer
    // having multiple active closings, since we're not aggregating them
    // into JSON in this query anymore (see big note above).
    //
    // GROUP BY note: only listing c.customer_id (plus the joined tables'
    // primary/foreign keys) works here because MySQL/MariaDB — same as
    // Postgres — allow selecting columns that are "functionally dependent"
    // on a GROUP BY column (e.g. all of c.* depend on c.customer_id, its
    // primary key). This requires ONLY_FULL_GROUP_BY mode to recognize the
    // dependency, which is the default in modern MySQL 5.7+/8+ and current
    // MariaDB — but if you're on an unusually old/custom sql_mode setting,
    // this could error. If it does, list every selected column explicitly
    // in the GROUP BY instead.
    const dataQuery = `
      SELECT
        c.customer_id,
        c.user_id,
        u.email,
        u.full_name,
        r.role_name                   AS role,
        c.contact_number,
        c.phone_number,
        c.cnic,
        c.city,
        c.address,
        c.father_name,
        c.marketer_id,
        u.status                      AS user_status,
        c.status                      AS customer_status,
        u.is_verified,
        c.created_at,
        creator.full_name             AS created_by_name

      FROM customers c
      JOIN users u         ON u.user_id       = c.user_id
      JOIN roles r         ON r.role_id       = u.role_id
      JOIN users creator   ON creator.user_id = c.created_by

      LEFT JOIN smd_closings sc
        ON sc.customer_id = c.customer_id
        AND sc.status = 'active'
      LEFT JOIN smds s
        ON s.smd_id = sc.smd_id

      ${whereClause}

      GROUP BY c.customer_id

      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const [customerRows] = await connection.query(dataQuery, [
      ...values,
      limit,
      offset,
    ]);

    const customers = customerRows as any[];

    /* -----------------------------
       Fetch active SMDs for just this page's customers, then merge in JS
    ------------------------------ */
    let smdsByCustomer: Record<string, any[]> = {};

    if (customers.length > 0) {
      const customerIds = customers.map((c) => c.customer_id);

      // NOTE: passing an array as the value for a single `?` inside an
      // IN (?) clause is a mysql2-specific convenience — it auto-expands
      // the array into "?, ?, ?..." for you. This ONLY works with
      // connection.query(), not connection.execute() (prepared
      // statements handle arrays differently) — worth remembering if any
      // other part of the codebase switches to .execute() later.
      const smdQuery = `
        SELECT
          sc.customer_id,
          s.smd_id,
          s.smd_code,
          s.title,
          s.address,
          sc.monthly_rent      AS monthly_payout,
          sc.sell_price,
          sc.share_percentage,
          sc.amount_paid,
          sc.remaining_balance,
          sc.deal_id,
          sc.status
        FROM smd_closings sc
        JOIN smds s ON s.smd_id = sc.smd_id
        WHERE sc.status = 'active'
          AND sc.customer_id IN (?)
      `;

      const [smdRows] = await connection.query(smdQuery, [customerIds]);

      for (const row of smdRows as any[]) {
        if (!smdsByCustomer[row.customer_id]) {
          smdsByCustomer[row.customer_id] = [];
        }
        smdsByCustomer[row.customer_id].push({
          smd_id: row.smd_id,
          smd_code: row.smd_code,
          title: row.title,
          address: row.address,
          monthly_payout: row.monthly_payout,
          sell_price: row.sell_price,
          share_percentage: row.share_percentage,
          amount_paid: row.amount_paid,
          remaining_balance: row.remaining_balance,
          deal_id: row.deal_id,
          status: row.status,
        });
      }
    }

    const data = customers.map((c) => ({
      ...c,
      smds: smdsByCustomer[c.customer_id] || [],
    }));

    res.status(200).json({
      message: "Customers fetched successfully",
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch customers" });
  } finally {
    connection.release();
  }
};


export const searchCustomersByName = async (req: Request, res: Response) => {
  const q = req.query.q as string || "";
  const user_id = req.user?.user_id;
  const role = req.user?.role;
  const isAdmin = role === "admin";

  // NOTE: no more conditional placeholder numbering ($1 vs $2 depending on
  // isAdmin) needed — MySQL's ? placeholders just match values.push() order,
  // so the ternary logic for numbering disappears entirely.
  //
  // NOTE: Postgres's `'%' || $2 || '%'` string concatenation operator (||)
  // doesn't work the same way in MySQL/MariaDB by default — standard
  // sql_mode treats || as logical OR, not concatenation. Use CONCAT()
  // instead, which is unambiguous and always available.
  //
  // NOTE: ILIKE -> LIKE, same case-sensitivity caveat as above.
  const queryText = `
    SELECT 
      c.customer_id,
      u.full_name
    FROM customers c
    JOIN users u ON u.user_id = c.user_id
    WHERE c.status = 'active'
      ${!isAdmin ? "AND c.created_by = ?" : ""}
      ${q ? "AND u.full_name LIKE CONCAT('%', ?, '%')" : ""}
    ORDER BY u.full_name
    LIMIT 10
  `;

  try {
    let values: any[] = [];
    if (!isAdmin) values.push(user_id);
    if (q) values.push(q);

    const [rows] = await pool.query(queryText, values);
    res.status(200).json(rows);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};


export const deleteCustomer = async (req: Request, res: Response) => {
  const connection = await pool.getConnection(); // NOTE: pool.connect() -> pool.getConnection()

  try {
    const { customerId } = req.params;
    const user = req.user as any;

    if (!customerId) {
      return res.status(400).json({
        message: "Customer ID is required",
      });
    }

    // NOTE: $1 -> ?, and no more idx counter needed since ? is purely
    // positional — order in the array just has to match order of
    // appearance in the SQL string.
    let conditions: string[] = [
      `customer_id = ?`,
      `status != 'deleted'`,
    ];

    let values: any[] = [customerId];

    /* -----------------------------
       Role-based restriction
    ------------------------------*/
    if (user.role === "staff") {
      conditions.push(`created_by = ?`);
      values.push(user.user_id);
    }
    // admin → no restriction

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    // NOTE: RETURNING customer_id removed entirely — MySQL/MariaDB has no
    // RETURNING clause on UPDATE at all. We don't actually need it back
    // here anyway since customerId is already known from req.params —
    // RETURNING was only ever useful for confirming the row existed,
    // which we can get another way (see below).
    const deleteQuery = `
      UPDATE customers
      SET
        status = 'deleted',
        updated_at = NOW()
      ${whereClause}
    `;

    const [result] = await connection.query(deleteQuery, values);

    // NOTE: result.rowCount (pg) -> (result as any).affectedRows (mysql2).
    // mysql2 returns a ResultSetHeader object for UPDATE/DELETE/INSERT
    // queries (not an array of rows), with affectedRows telling you how
    // many rows matched the WHERE clause and were updated. This is the
    // direct equivalent of what RETURNING + rowCount was checking before.
    if ((result as any).affectedRows === 0) {
      return res.status(404).json({
        message:
          "Customer not found or you are not allowed to delete this customer",
      });
    }

    res.status(200).json({
      message: "Customer deleted successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to delete customer",
    });
  } finally {
    connection.release();
  }
};


export const hardDeleteCustomer = async (req: Request, res: Response) => {
  const connection = await pool.getConnection();

  try {
    const { customerId } = req.params;
    const user = req.user as any;

    if (!customerId) {
      return res.status(400).json({
        message: "Customer ID is required",
      });
    }

    let conditions: string[] = [
      `customer_id = ?`,
    ];

    let values: any[] = [customerId];

    /* -----------------------------
       Role-based restriction
    ------------------------------*/
    if (user.role === "staff") {
      conditions.push(`created_by = ?`);
      values.push(user.user_id);
    }

    // admin → no restriction

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    // NOTE: same as above — RETURNING customer_id removed, not needed
    const deleteQuery = `
      DELETE FROM customers
      ${whereClause}
    `;

    const [result] = await connection.query(deleteQuery, values);

    // NOTE: rowCount -> affectedRows, same as deleteCustomer above
    if ((result as any).affectedRows === 0) {
      return res.status(404).json({
        message:
          "Customer not found or you are not allowed to delete this customer",
      });
    }

    res.status(200).json({
      message: "Customer permanently deleted successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to delete customer",
    });
  } finally {
    connection.release();
  }
};



export const getCustomerDetails = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {

    /* =========================
       1️⃣ CUSTOMER DETAILS
    ========================== */
    // NOTE: $1 -> ?
    const customerQuery = `
      SELECT 
        c.customer_id,
        u.full_name,
        u.email,
        c.contact_number,
        c.phone_number,
        c.cnic,
        c.city,
        c.address,
        c.father_name,
        c.created_at,
        mu.full_name AS reference_name
      FROM customers c
      JOIN users u ON c.user_id = u.user_id
      LEFT JOIN marketers m ON c.marketer_id = m.marketer_id
      LEFT JOIN users mu ON m.user_id = mu.user_id
      WHERE c.customer_id = ?
    `;

    // NOTE: mysql2 returns [rows, fields], not { rows, rowCount }
    const [customerRows] = await pool.query(customerQuery, [id]);
    const customerResult = customerRows as any[];

    if (customerResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found"
      });
    }

    const customer = customerResult[0];


    /* =========================
       2️⃣ BANK ACCOUNTS
    ========================== */
    const bankQuery = `
      SELECT
        bank_account_id,
        bank_name,
        account_name,
        account_number,
        created_at
      FROM customer_bank_accounts
      WHERE customer_id = ?
      ORDER BY created_at DESC
    `;

    const [bankRows] = await pool.query(bankQuery, [id]);


    /* =========================
       3️⃣ HEIRS
    ========================== */
    const heirQuery = `
      SELECT
        customer_heir_id,
        full_name,
        cnic,
        phone_number,
        created_at
      FROM customer_heirs
      WHERE customer_id = ?
      ORDER BY created_at ASC
    `;

    const [heirRows] = await pool.query(heirQuery, [id]);


    /* =========================
       4️⃣ SMD CLOSINGS
    ========================== */
    const smdQuery = `
      SELECT
        sc.smd_closing_id,
        s.smd_id,
        s.smd_code,
        s.title,
        s.address       AS smd_address,
        sc.closed_at    AS closing_date,
        sc.sell_price,
        sc.monthly_rent,
        sc.share_percentage,
        sc.amount_paid,
        sc.remaining_balance,
        sc.deal_id,
        sc.status       AS closing_status
      FROM smd_closings sc
      JOIN smds s ON sc.smd_id = s.smd_id
      WHERE sc.customer_id = ?
      ORDER BY sc.closed_at DESC
    `;

    const [smdRows] = await pool.query(smdQuery, [id]);
    const closings = smdRows as any[];
    const closingIds = closings.map(c => c.smd_closing_id);


    /* =========================
       5️⃣ RENT PAYOUTS
    ========================== */
    let payoutsMap: Record<string, any[]> = {};

    if (closingIds.length > 0) {
      // NOTE: Postgres's `= ANY($1::uuid[])` is array-membership syntax with
      // an explicit array cast — MySQL/MariaDB has no array type and no
      // ANY() operator used this way at all. The direct equivalent is
      // `IN (?)`, and mysql2 has a specific convenience for this: passing
      // a JS array as the value for a single `?` inside IN (?) auto-expands
      // it into "?, ?, ?..." for you. Since our UUIDs are stored as
      // CHAR(36) strings (not a native uuid type), no cast is needed either
      // — just pass the plain string array directly.
      const payoutQuery = `
        SELECT
          payout_id,
          smd_closing_id,
          payout_month,
          amount,
          status,
          paid_at,
          created_at
        FROM smd_rent_payouts
        WHERE smd_closing_id IN (?)
        ORDER BY payout_month DESC
      `;

      const [payoutRows] = await pool.query(payoutQuery, [closingIds]);

      (payoutRows as any[]).forEach(p => {
        if (!payoutsMap[p.smd_closing_id]) {
          payoutsMap[p.smd_closing_id] = [];
        }
        payoutsMap[p.smd_closing_id].push(p);
      });
    }


    /* =========================
       6️⃣ FINAL RESPONSE
    ========================== */
    const smds = closings.map(closing => {
      const payouts = payoutsMap[closing.smd_closing_id] || [];

      const paidMonths = new Set(payouts.map((p: any) => p.payout_month));

      // NOTE: closing.monthly_rent comes back from mysql2 as a STRING
      // (DECIMAL columns are stringified by default to avoid precision
      // loss), same as it would have needed parseFloat() in Postgres too
      // if the driver config differed — no functional change needed here
      // since parseFloat() already handles a string input correctly, just
      // flagging that this line is now load-bearing rather than just safe.
      const unpaid_months = getUnpaidMonths(
        new Date(closing.closing_date),
        parseFloat(closing.monthly_rent),
        paidMonths
      );

      const rent_liability = parseFloat(
        unpaid_months.reduce((sum, m) => sum + m.amount, 0).toFixed(2)
      );

      return {
        smd_closing_id:   closing.smd_closing_id,
        smd_id:           closing.smd_id,
        smd_code:         closing.smd_code,
        title:            closing.title,
        smd_address:      closing.smd_address,
        closing_date:     closing.closing_date,
        sell_price:       closing.sell_price,
        monthly_rent:     closing.monthly_rent,
        share_percentage: closing.share_percentage,
        amount_paid:      closing.amount_paid,
        remaining_balance:closing.remaining_balance,
        deal_id:          closing.deal_id,
        rent_liability,
        unpaid_months,
        status:           closing.closing_status,
        rent_payouts:     payouts
      };
    });

    const response = {
      customer_id:    customer.customer_id,
      full_name:      customer.full_name,
      reference:      customer.reference_name || null,
      email:          customer.email,
      contact_number: customer.contact_number,
      phone_number:   customer.phone_number,
      cnic:           customer.cnic,
      city:           customer.city,
      address:        customer.address,
      father_name:    customer.father_name,
      created_at:     customer.created_at,

      bank_accounts: bankRows,
      heirs:         heirRows,
      smds
    };

    res.status(200).json({
      success: true,
      data: response
    });

  } catch (error) {
    console.error("❌ Get customer details error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch customer details"
    });
  }
};

