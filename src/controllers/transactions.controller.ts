// src/controllers/transactionsController.ts
import { Request, Response } from "express";
import { pool } from "../config/db"; // adjust to your actual pool import
import { RowDataPacket } from "mysql2";

interface PeriodSummary {
  total_in: number;
  total_out: number;
  revenue: number;
  rent_paid_out: number;
  commission_paid_out: number;
}

const SUMMARY_QUERY = `
  SELECT
    COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount ELSE 0 END), 0) AS total_in,
    COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) AS total_out,
    COALESCE(SUM(CASE WHEN type = 'income_sale'       THEN amount ELSE 0 END), 0) AS revenue,
    COALESCE(SUM(CASE WHEN type = 'rent_payout'       THEN amount ELSE 0 END), 0) AS rent_paid_out,
    COALESCE(SUM(CASE WHEN type = 'commission_payout' THEN amount ELSE 0 END), 0) AS commission_paid_out
  FROM transactions
  WHERE txn_date >= ? AND txn_date < ?
`;

const getPeriodSummary = async (start: Date, end: Date): Promise<PeriodSummary> => {
  const [rows] = await pool.query<RowDataPacket[]>(SUMMARY_QUERY, [start, end]);
  const row = rows[0];
  return {
    total_in: Number(row.total_in),
    total_out: Number(row.total_out),
    revenue: Number(row.revenue),
    rent_paid_out: Number(row.rent_paid_out),
    commission_paid_out: Number(row.commission_paid_out),
  };
};

// Boundaries computed in Node (not MySQL CURDATE()) so "today" matches your
// actual local time regardless of what timezone the DB server thinks it's in.
const getDateBoundaries = () => {
  const now = new Date();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  const dayOfWeek = (startOfToday.getDay() + 6) % 7; // Monday = 0
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - dayOfWeek);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return { startOfToday, startOfTomorrow, startOfWeek, startOfMonth };
};

export const getTransactionSummary = async (req: Request, res: Response) => {
  try {
    const { startOfToday, startOfTomorrow, startOfWeek, startOfMonth } = getDateBoundaries();

    const [today, thisWeek, thisMonth] = await Promise.all([
      getPeriodSummary(startOfToday, startOfTomorrow),
      getPeriodSummary(startOfWeek, startOfTomorrow),
      getPeriodSummary(startOfMonth, startOfTomorrow),
    ]);

    // Trend: last 30 days, grouped by day, for the chart
    const trendStart = new Date(startOfToday.getTime() - 29 * 24 * 60 * 60 * 1000);

    const [trendRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        DATE(txn_date) AS day,
        COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) AS total_out
      FROM transactions
      WHERE txn_date >= ?
      GROUP BY DATE(txn_date)
      ORDER BY day ASC
      `,
      [trendStart]
    );

    const trend = trendRows.map((r) => ({
      date: r.day,
      total_in: Number(r.total_in),
      total_out: Number(r.total_out),
    }));

    res.status(200).json({ today, this_week: thisWeek, this_month: thisMonth, trend });
  } catch (error: any) {
    console.error("[getTransactionSummary] Error:", error);
    res.status(500).json({ message: "Failed to fetch transaction summary" });
  }
};