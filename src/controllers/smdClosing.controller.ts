import { Request, Response } from "express";
import { pool } from "../config/db";
import { RowDataPacket, ResultSetHeader } from "mysql2";
import { randomUUID } from "crypto";
import { notifyTransaction } from "../services/transactionNotificationService";
import { getCustomerContactInfo } from "../services/customerContactService";


const ALLOWED_PAYMENT_METHODS = ["cash", "bank_transfer", "cheque", "online"] as const;
type PaymentMethod = typeof ALLOWED_PAYMENT_METHODS[number];

export const createSmdClosing = async (req: Request, res: Response) => {
  const connection = await pool.getConnection();

  try {
    const { customer_id, smds, payment_method } = req.body;
    console.log("SMDs: ", smds);

    const closedBy = req.user!.user_id;
    const role = req.user!.role;

    if (!["admin", "staff"].includes(role)) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!customer_id || !Array.isArray(smds) || smds.length === 0) {
      return res.status(400).json({ message: "Invalid payload" });
    }

    const hasUpfrontPayment = smds.some((s: any) => Number(s.amount_paid) > 0);

    if (hasUpfrontPayment) {
      if (!payment_method || !ALLOWED_PAYMENT_METHODS.includes(payment_method)) {
        return res.status(400).json({
          message: `payment_method is required and must be one of: ${ALLOWED_PAYMENT_METHODS.join(", ")}`,
        });
      }
    }

    // ⭐ after validation, narrow the type
    const validatedPaymentMethod = payment_method as PaymentMethod | undefined;

    await connection.beginTransaction();

    // 1️⃣ Validate customer
    const [customerRows] = await connection.query<RowDataPacket[]>(
      `
      SELECT c.customer_id
      FROM customers c
      JOIN users u ON u.user_id = c.user_id
      WHERE c.customer_id = ?
        AND u.status = 'active'
        AND c.status = 'active'
      `,
      [customer_id]
    );

    if (!customerRows.length) {
      throw new Error("Customer not eligible");
    }

    // ⭐ NEW → calculate total amount
    const totalAmount = smds.reduce(
      (sum: number, s: any) => sum + Number(s.sell_price || 0),
      0
    );

    // ⭐ NEW → create deal record
    const dealId = randomUUID();

    await connection.query<ResultSetHeader>(
      `
      INSERT INTO smd_deals (deal_id, customer_id, created_by, total_amount)
      VALUES (?, ?, ?, ?)
      `,
      [dealId, customer_id, closedBy, totalAmount]
    );

    const insertedClosings: string[] = [];
    const paymentsToNotify: Array<{ amount: number; smd_closing_id: string }> = [];

    // 2️⃣ Loop each SMD
    for (const smd of smds) {
      const { smd_id, sell_price, monthly_rent, amount_paid, share_percentage } = smd;

      if (!smd_id || !sell_price || !monthly_rent || !share_percentage) {
        throw new Error("Missing SMD fields");
      }

      // Lock SMD row
      const [smdRows] = await connection.query<RowDataPacket[]>(
        `SELECT smd_id FROM smds WHERE smd_id = ? FOR UPDATE`,
        [smd_id]
      );

      if (!smdRows.length) {
        throw new Error(`SMD not found: ${smd_id}`);
      }

      // Check current total share
      const [shareRows] = await connection.query<RowDataPacket[]>(
        `
        SELECT COALESCE(SUM(share_percentage), 0) AS total_share
        FROM smd_closings
        WHERE smd_id = ?
        AND status = 'active'
        `,
        [smd_id]
      );

      const currentShare = Number(shareRows[0].total_share);
      const newShare = Number(share_percentage);

      if (currentShare + newShare > 100) {
        throw new Error(
          `Share exceeds 100% for SMD ${smd_id}. Remaining: ${100 - currentShare}%`
        );
      }

      // ⭐ UPDATED → Insert closing WITH deal_id
      const remainingBalance = Number(sell_price) - (Number(amount_paid) || 0);
      const smdClosingId = randomUUID();

      await connection.query<ResultSetHeader>(
        `
        INSERT INTO smd_closings (
          smd_closing_id,
          smd_id,
          customer_id,
          sell_price,
          monthly_rent,
          share_percentage,
          amount_paid,
          closed_by,
          deal_id,
          remaining_balance
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,?)
        `,
        [
          smdClosingId,
          smd_id,
          customer_id,
          sell_price,
          monthly_rent,
          newShare,
          amount_paid,
          closedBy,
          dealId,
          remainingBalance
        ]
      );

      insertedClosings.push(smdClosingId);

      // ⭐ NEW → if customer paid something upfront, record it as a real payment
      if (Number(amount_paid) > 0) {
        const paymentId = randomUUID();

        await connection.query<ResultSetHeader>(
          `
            INSERT INTO smd_closing_payments (
              payment_id, smd_closing_id, amount, payment_date, payment_method, recorded_by
              )
            VALUES (?, ?, ?, NOW(), ?, ?)
          `,
          [paymentId, smdClosingId, amount_paid, validatedPaymentMethod, closedBy]
        );

        const transactionId = randomUUID();

        await connection.query<ResultSetHeader>(
          `
            INSERT INTO transactions (
              transaction_id, type, direction, amount, txn_date,
              source_table, source_id, smd_closing_id, marketer_id, recorded_by
            )
            VALUES (?, 'income_sale', 'in', ?, NOW(), 'smd_closing_payments', ?, ?, NULL, ?)
          `,
          [transactionId, amount_paid, paymentId, smdClosingId, closedBy]
        );

        paymentsToNotify.push({ amount: Number(amount_paid), smd_closing_id: smdClosingId });
      }
    }

    await connection.commit();

    const contact = await getCustomerContactInfo(customer_id);
    const customer_name = contact.customer_name ?? undefined;
    const marketer_name = contact.marketer_name ?? "Not assigned";

        // fire-and-forget — one email per upfront payment in this deal
    for (const p of paymentsToNotify) {
      notifyTransaction({
        type: "income_sale",
        direction: "in",
        amount: p.amount,
        txn_date: new Date(),
        context: {
          deal_reference: p.smd_closing_id.slice(0, 8),
          customer_name,
          marketer_name: marketer_name ?? "Not assigned",
          payment_method,
        },
      }).catch((err) => console.error("[notifyTransaction] failed:", err));
    }

    res.status(201).json({
      message: "SMD deals closed successfully",
      data: {
        deal_id: dealId,
        smd_closing_ids: insertedClosings,
      },
    });
  } catch (error: any) {
    await connection.rollback();
    console.error(error);

    res.status(500).json({
      message: error.message || "Failed to close SMD deals",
    });
  } finally {
    connection.release();
  }
};


export const getSmdClosings = async (req: Request, res: Response) => {
  const connection = await pool.getConnection();

  try {
    const { search } = req.query;

    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
    const offset = (page - 1) * limit;

    let conditions: string[] = [];
    let values: any[] = [];

    if (search) {
      conditions.push(`
        (
          s.smd_code    LIKE ?
          OR u.full_name  LIKE ?
          OR mu.full_name LIKE ?
        )
      `);
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    /* -----------------------------
       1️⃣ Count
    ------------------------------ */
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM smd_closings sc
      JOIN customers c  ON c.customer_id = sc.customer_id
      JOIN users u      ON u.user_id = c.user_id
      JOIN smds s       ON s.smd_id = sc.smd_id
      LEFT JOIN marketers m  ON m.marketer_id = c.marketer_id
      LEFT JOIN users mu     ON mu.user_id = m.user_id
      ${whereClause}
    `;

    const [countRows] = await connection.query<RowDataPacket[]>(countQuery, values);
    const total = Number(countRows[0].total);

    /* -----------------------------
       2️⃣ Data
    ------------------------------ */
    const dataQuery = `
      SELECT
        sc.smd_closing_id,
        sc.status           AS closing_status,
        sc.sell_price,
        sc.monthly_rent,
        sc.share_percentage,
        sc.amount_paid,
        sc.remaining_balance,
        sc.deal_id,
        sc.created_at,
        sc.closed_at,

        -- smd
        s.smd_id,
        s.smd_code,
        s.title,
        s.address           AS smd_address,

        -- customer
        c.customer_id,
        c.city              AS customer_city,
        u.full_name         AS customer_name,
        u.email             AS customer_email,
        c.contact_number,

        -- marketer
        m.marketer_id,
        mu.full_name        AS marketer_name,
        mu.email            AS marketer_email,

        -- closed by
        sc.closed_by,
        cu.full_name        AS closed_by_name

      FROM smd_closings sc
      JOIN smds s       ON s.smd_id = sc.smd_id
      JOIN customers c  ON c.customer_id = sc.customer_id
      JOIN users u      ON u.user_id = c.user_id

      LEFT JOIN marketers m  ON m.marketer_id = c.marketer_id
      LEFT JOIN users mu     ON mu.user_id = m.user_id
      LEFT JOIN users cu     ON cu.user_id = sc.closed_by

      ${whereClause}
      ORDER BY sc.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.query<RowDataPacket[]>(dataQuery, [
      ...values,
      limit,
      offset,
    ]);

    res.status(200).json({
      message: "SMD closings fetched successfully",
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      data: rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch SMD closings" });
  } finally {
    connection.release();
  }
};

export const recordClosingPayment = async (req: Request, res: Response) => {
  const connection = await pool.getConnection();

  try {
    const { smd_closing_id } = req.params;
    const { amount, payment_method, reference_no, notes } = req.body;

    const userId = req.user!.user_id;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    await connection.beginTransaction();

    // Insert payment
    const paymentId = randomUUID();

    await connection.query<ResultSetHeader>(
      `
      INSERT INTO smd_closing_payments (
        payment_id,
        smd_closing_id,
        amount,
        payment_method,
        reference_no,
        notes,
        recorded_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [paymentId, smd_closing_id, amount, payment_method, reference_no, notes, userId]
    );

    // Update totals
    // NOTE: remaining_balance is a plain writable column in the MySQL schema
    // (not a generated column like Postgres's `sell_price - amount_paid` default),
    // so it must be recomputed explicitly here or it will go stale.
    await connection.query<ResultSetHeader>(
      `
      UPDATE smd_closings
      SET amount_paid = amount_paid + ?,
          remaining_balance = sell_price - (amount_paid + ?),
          updated_at = NOW()
      WHERE smd_closing_id = ?
      `,
      [amount, amount, smd_closing_id]
    );

    await connection.commit();

    res.json({ message: "Payment recorded successfully" });

  } catch (error: any) {
    await connection.rollback();
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};