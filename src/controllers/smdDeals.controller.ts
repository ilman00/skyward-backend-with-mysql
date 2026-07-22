import { Request, Response } from "express";
import { pool } from "../config/db";
import { RowDataPacket } from "mysql2";


export const getDeals = async (req: Request, res: Response) => {
    let connection;
    try {
        const userId = req.user!.user_id;
        const role = req.user!.role;

        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        connection = await pool.getConnection();

        const baseQuery = `
            FROM smd_deals d
            JOIN customers c ON c.customer_id = d.customer_id
            JOIN users creator ON creator.user_id = d.created_by
            JOIN users customer_user ON customer_user.user_id = c.user_id
            `;

        const whereClause =
            role === "admin" ? "" : `WHERE d.created_by = ?`;

        const params = role === "admin" ? [] : [userId];

        // Count
        const [countRows] = await connection.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS count ${baseQuery} ${whereClause}`,
            params
        );

        // Data
        const [dataRows] = await connection.query<RowDataPacket[]>(
  `
  SELECT 
    d.deal_id,
    d.total_amount,
    d.created_at,

    customer_user.full_name AS customer_name,
    customer_user.email AS customer_email,
    c.phone_number,
    c.city,

    creator.full_name AS created_by_name,

    (
      SELECT COUNT(*) 
      FROM smd_closings sc 
      WHERE sc.deal_id = d.deal_id
    ) AS smd_count

  ${baseQuery}
  ${whereClause}
  ORDER BY d.created_at DESC
  LIMIT ? OFFSET ?
  `,
  [...params, limit, offset]
);

        res.json({
            page,
            limit,
            total: Number(countRows[0].count),
            data: dataRows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch deals" });
    } finally {
        if (connection) connection.release();
    }
};


export const getDealById = async (req: Request, res: Response) => {
    let connection;
    try {
        const { deal_id } = req.params;

        connection = await pool.getConnection();

        const [dealRows] = await connection.query<RowDataPacket[]>(
            `
      SELECT 
        d.deal_id,
        d.total_amount,
        d.created_at,
        u.full_name AS created_by_name,

        c.customer_id,
        c.phone_number,
        c.cnic,
        c.city,
        c.address

      FROM smd_deals d
      JOIN customers c ON c.customer_id = d.customer_id
      JOIN users u ON u.user_id = d.created_by
      WHERE d.deal_id = ?
      `,
            [deal_id]
        );

        if (!dealRows.length) {
            return res.status(404).json({ message: "Deal not found" });
        }

        const [smdsRows] = await connection.query<RowDataPacket[]>(
            `
      SELECT 
        sc.smd_closing_id,
        sc.sell_price,
        sc.monthly_rent,
        sc.share_percentage,

        s.smd_code,
        s.title,
        s.address

      FROM smd_closings sc
      JOIN smds s ON s.smd_id = sc.smd_id
      WHERE sc.deal_id = ?
      `,
            [deal_id]
        );

        res.json({
            deal: dealRows[0],
            smds: smdsRows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch deal details" });
    } finally {
        if (connection) connection.release();
    }
};