import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db";
import { RowDataPacket } from "mysql2";
import { AppError } from "./user.controller";

export const getMarketerDetails = async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    if (!id) {
        return next(new AppError(400, "Marketer ID is required"));
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // 1. Marketer + linked user info
        const [marketerRows] = await connection.query<RowDataPacket[]>(
            `SELECT m.marketer_id, m.commission_type, m.commission_value, m.status,
          u.full_name, u.email
   FROM marketers m
   JOIN users u ON u.user_id = m.user_id
   WHERE m.marketer_id = ?`,
            [id]
        );

        if (marketerRows.length === 0) {
            return next(new AppError(404, "Marketer not found"));
        }

        const marketer = marketerRows[0];

        // 2. Hierarchical data: customers -> smd_closings -> smds, with rent paid per closing
        const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT 
      c.customer_id,
      cu.full_name AS customer_name,
      sc.smd_closing_id,
      sc.sell_price,
      sc.monthly_rent,
      sc.status AS closing_status,
      s.smd_id,
      s.smd_code,
      COALESCE(SUM(CASE WHEN rp.status = 'paid' THEN rp.amount ELSE 0 END), 0) AS total_paid_to_customer
   FROM customers c
   JOIN users cu ON cu.user_id = c.user_id
   LEFT JOIN smd_closings sc ON sc.customer_id = c.customer_id
   LEFT JOIN smds s ON s.smd_id = sc.smd_id
   LEFT JOIN smd_rent_payouts rp ON rp.smd_closing_id = sc.smd_closing_id
   WHERE c.marketer_id = ?
   GROUP BY c.customer_id, cu.full_name, sc.smd_closing_id, sc.sell_price, sc.monthly_rent, sc.status, s.smd_id, s.smd_code
   ORDER BY cu.full_name, s.smd_code`,
            [id]
        );

        // 3. Aggregate totals across all this marketer's customers
        const [totalsRows] = await connection.query<RowDataPacket[]>(
            `SELECT 
      COALESCE(SUM(sc.sell_price), 0) AS total_revenue,
      COALESCE((
        SELECT SUM(rp.amount)
        FROM smd_rent_payouts rp
        JOIN smd_closings sc2 ON sc2.smd_closing_id = rp.smd_closing_id
        JOIN customers c2 ON c2.customer_id = sc2.customer_id
        WHERE c2.marketer_id = ? AND rp.status = 'paid'
      ), 0) AS total_rent_paid,
      COALESCE((
        SELECT SUM(mc.amount)
        FROM marketer_commissions mc
        WHERE mc.marketer_id = ? AND mc.status = 'paid'
      ), 0) AS total_commission_paid,
      COALESCE((
        SELECT SUM(mc.amount)
        FROM marketer_commissions mc
        WHERE mc.marketer_id = ? AND mc.status = 'pending'
      ), 0) AS total_commission_pending
   FROM smd_closings sc
   JOIN customers c ON c.customer_id = sc.customer_id
   WHERE c.marketer_id = ?`,
            [id, id, id, id]
        );
        const totals = totalsRows[0];

        // Group flat rows into customer -> smds hierarchy
        const customersMap = new Map();

        for (const row of rows) {
            if (!customersMap.has(row.customer_id)) {
                customersMap.set(row.customer_id, {
                    customer_id: row.customer_id,
                    full_name: row.customer_name,
                    smds: [],
                });
            }

            if (row.smd_id) {
                customersMap.get(row.customer_id).smds.push({
                    smd_closing_id: row.smd_closing_id,
                    smd_id: row.smd_id,
                    smd_code: row.smd_code,
                    monthly_rent: Number(row.monthly_rent),
                    sell_price: Number(row.sell_price),
                    status: row.closing_status,
                    total_paid_to_customer: Number(row.total_paid_to_customer),
                });
            }
        }

        const responseData = {
            marketer_id: marketer.marketer_id,
            full_name: marketer.full_name,
            email: marketer.email,
            commission_type: marketer.commission_type,
            commission_value: Number(marketer.commission_value),
            status: marketer.status,
            total_revenue: Number(totals.total_revenue),
            total_rent_paid: Number(totals.total_rent_paid),
            customers: Array.from(customersMap.values()),
            total_commission_paid: Number(totals.total_commission_paid),
            total_commission_pending: Number(totals.total_commission_pending),
        };

        return res.status(200).json({
            success: true,
            data: responseData,
        });
    } catch (err) {
        return next(err);
    } finally {
        if (connection) connection.release();
    }
};

export const getSmdRentHistory = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const { smdClosingId } = req.params;

    if (!smdClosingId) {
        return next(new AppError(400, "SMD Closing ID is required"));
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT payout_id, payout_month, amount, status, paid_at
       FROM smd_rent_payouts
       WHERE smd_closing_id = ?
       ORDER BY payout_month ASC`,
            [smdClosingId]
        );

        return res.status(200).json({
            success: true,
            data: rows.map((r) => ({
                payout_id: r.payout_id,
                payout_month: r.payout_month,
                amount: Number(r.amount),
                status: r.status,
                paid_at: r.paid_at,
            })),
        });
    } catch (err) {
        return next(err);
    } finally {
        if (connection) connection.release();
    }
};