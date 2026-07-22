import { Request, Response} from 'express';
import { pool } from '../config/db';


export const getCustomerSmds = async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;
    const { search, page = "1", limit = "10" } = req.query;

    const pageNumber = Math.max(parseInt(page as string, 10), 1);
    const pageSize = Math.max(parseInt(limit as string, 10), 10);
    const offset = (pageNumber - 1) * pageSize;

    const values: any[] = [customerId];
    let searchCondition = "";

    // NOTE: ILIKE -> LIKE (no case-insensitive LIKE variant in MySQL/MariaDB,
    // relies on column collation instead — see earlier notes on this).
    // NOTE: Postgres reused $2 for both conditions in the OR — MySQL's `?`
    // is positional, so the search term needs to be pushed twice, once per
    // placeholder occurrence.
    if (search) {
      searchCondition = `
        AND (
          s.smd_code LIKE ?
          OR s.title LIKE ?
        )
      `;
      values.push(`%${search}%`, `%${search}%`);
    }

    // NOTE: added explicit "AS count" — see watch-out above. Without this,
    // MySQL names the column literally "COUNT(*)", and row.count would be
    // undefined, silently breaking pagination (NaN totals) with no error.
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM smds s
      INNER JOIN customers c ON c.user_id = s.owner_user_id
      WHERE c.customer_id = ?
      ${searchCondition}
    `;

    // NOTE: Postgres numbered the LIMIT/OFFSET placeholders based on
    // values.length (since it needed to know which $n came next). MySQL's
    // `?` doesn't need this — just add two more `?` in the SQL and push the
    // two extra values in the same order, same as everywhere else.
    const dataQuery = `
      SELECT
        s.smd_id,
        s.smd_code,
        s.title,
        s.status,
        s.city,
        s.area,
        s.monthly_payout,
        s.is_active
      FROM smds s
      INNER JOIN customers c ON c.user_id = s.owner_user_id
      WHERE c.customer_id = ?
      ${searchCondition}
      ORDER BY s.created_at DESC
      LIMIT ?
      OFFSET ?
    `;

    const [totalRows] = await pool.query(countQuery, values);
    const total = Number((totalRows as any[])[0].count);

    const [dataRows] = await pool.query(dataQuery, [
      ...values,
      pageSize,
      offset,
    ]);

    res.json({
      meta: {
        total,
        page: pageNumber,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
      data: dataRows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
};



export const getLinkedSmdCustomers = async (req: Request, res: Response) => {
  try {
    const { search, page = "1", limit = "10" } = req.query;

    const pageNumber = Math.max(parseInt(page as string, 10), 1);
    const pageSize = Math.max(parseInt(limit as string, 10), 10);
    const offset = (pageNumber - 1) * pageSize;

    const values: any[] = [];
    let searchCondition = "";

    // NOTE: same two fixes as above — ILIKE -> LIKE, and $1 reused 3 times
    // needs the search term pushed 3 times for MySQL's positional ? style.
    if (search) {
      searchCondition = `
        WHERE s.smd_code LIKE ? 
        OR u.full_name LIKE ? 
        OR c.cnic LIKE ?
      `;
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // 1. Get Total Count for Pagination
    // NOTE: same "AS count" alias fix as the other handler
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM smds s
      LEFT JOIN users u ON s.owner_user_id = u.user_id
      LEFT JOIN customers c ON c.user_id = u.user_id
      ${searchCondition}
    `;

    // 2. Get Joined Data
    const dataQuery = `
      SELECT 
        s.smd_id,
        s.smd_code,
        s.title AS smd_title,
        s.status AS smd_status,
        s.city AS smd_city,
        u.user_id,
        u.full_name AS customer_name,
        u.email AS customer_email,
        c.contact_number,
        c.cnic
      FROM smds s
      LEFT JOIN users u ON s.owner_user_id = u.user_id
      LEFT JOIN customers c ON c.user_id = u.user_id
      ${searchCondition}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const [countRows] = await pool.query(countQuery, values);
    const total = parseInt((countRows as any[])[0].count, 10);

    const [dataRows] = await pool.query(dataQuery, [...values, pageSize, offset]);

    return res.status(200).json({
      meta: {
        total,
        page: pageNumber,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
      data: dataRows,
    });
  } catch (error) {
    console.error("Error fetching linked data:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};