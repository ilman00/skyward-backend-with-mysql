import { Request, Response } from "express";
import { pool } from "../config/db"; // now a mysql2/promise pool — see note below

export const getDashboardStats = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const statsQuery = `
      SELECT
        -- Total customers (non-deleted)
        -- NOTE: removed the '::int' cast — that's Postgres cast syntax and
        -- isn't valid in MySQL/MariaDB. COUNT(*) already returns an integer.
        (
          SELECT COUNT(*)
          FROM customers
          WHERE status != 'deleted'
        ) AS total_customers,

        -- Customers added this month
        -- NOTE: date_trunc('month', now()) has no direct MySQL equivalent.
        -- DATE_FORMAT(NOW(), '%Y-%m-01') gives the first day of the current
        -- month, which is the same thing date_trunc('month', ...) was doing.
        (
          SELECT COUNT(*)
          FROM customers
          WHERE status != 'deleted'
            AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
        ) AS customers_this_month,

        -- Customers added last month
        -- NOTE: Postgres date_trunc(...) - INTERVAL '1 month' becomes
        -- MySQL's DATE_SUB(<date>, INTERVAL 1 MONTH). Also note MySQL
        -- requires INTERVAL <number> <unit> with no quotes around the number.
        (
          SELECT COUNT(*)
          FROM customers
          WHERE status != 'deleted'
            AND created_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 1 MONTH)
            AND created_at <  DATE_FORMAT(NOW(), '%Y-%m-01')
        ) AS customers_last_month,

        -- Active marketers
        (
          SELECT COUNT(*)
          FROM marketers
          WHERE status = 'active'
        ) AS active_marketers,

        -- Marketers added this month
        (
          SELECT COUNT(*)
          FROM marketers
          WHERE status = 'active'
            AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
        ) AS marketers_this_month,

        -- Total SMDs (non-removed)
        (
          SELECT COUNT(*)
          FROM smds
          WHERE status != 'removed'
        ) AS total_smds,

        -- SMDs added this month
        (
          SELECT COUNT(*)
          FROM smds
          WHERE status != 'removed'
            AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
        ) AS smds_this_month,

        -- SMDs added last month
        (
          SELECT COUNT(*)
          FROM smds
          WHERE status != 'removed'
            AND created_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 1 MONTH)
            AND created_at <  DATE_FORMAT(NOW(), '%Y-%m-01')
        ) AS smds_last_month,

        -- Monthly rent liability: sum of monthly_rent for all active closings
        -- NOTE: removed '::numeric' cast (Postgres syntax, not valid in MySQL).
        -- IMPORTANT GOTCHA: mysql2 returns DECIMAL columns as STRINGS by
        -- default (not JS numbers), to avoid precision loss. Your existing
        -- code already wraps this in Number(...) below, which is correct
        -- and now actually necessary rather than just defensive.
        (
          SELECT COALESCE(SUM(monthly_rent), 0)
          FROM smd_closings
          WHERE status = 'active'
        ) AS monthly_rent_liability,

        -- Pending rent payouts this month
        -- NOTE: to_char(now(), 'YYYY-MM') -> DATE_FORMAT(NOW(), '%Y-%m').
        -- Format placeholders are different between Postgres and MySQL
        -- (YYYY-MM vs %Y-%m) — easy to miss since they look similar.
        (
          SELECT COUNT(*)
          FROM smd_rent_payouts
          WHERE status = 'pending'
            AND payout_month = DATE_FORMAT(NOW(), '%Y-%m')
        ) AS pending_rent_payouts_this_month
    `;

    // NOTE: mysql2's pool.query() returns a [rows, fields] tuple, not a
    // { rows: [...] } object like `pg` does. Destructure accordingly.
    const [rows] = await pool.query(statsQuery);
    const row = (rows as any[])[0];

    // Calculate trends (percentage change vs last month)
    const customerTrend =
      row.customers_last_month > 0
        ? Math.round(
            ((row.customers_this_month - row.customers_last_month) /
              row.customers_last_month) *
              100
          )
        : null;

    const smdTrend =
      row.smds_last_month > 0
        ? Math.round(
            ((row.smds_this_month - row.smds_last_month) /
              row.smds_last_month) *
              100
          )
        : null;

    res.status(200).json({
      success: true,
      data: {
        total_customers: row.total_customers,
        customers_this_month: row.customers_this_month,
        customer_trend: customerTrend,

        active_marketers: row.active_marketers,
        marketers_this_month: row.marketers_this_month,

        total_smds: row.total_smds,
        smds_this_month: row.smds_this_month,
        smd_trend: smdTrend,

        monthly_rent_liability: Number(row.monthly_rent_liability),
        pending_rent_payouts_this_month: row.pending_rent_payouts_this_month,
      },
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};