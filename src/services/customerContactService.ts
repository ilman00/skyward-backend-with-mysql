// src/services/customerContactService.ts
import { pool } from "../config/db"; // adjust to your actual pool import
import { RowDataPacket } from "mysql2";

export interface CustomerContactInfo {
  customer_name: string | null;
  marketer_name: string | null;
}

export const getCustomerContactInfo = async (customerId: string): Promise<CustomerContactInfo> => {
  const [rows] = await pool.query<RowDataPacket[]>(
    `
    SELECT
      cu.full_name AS customer_name,
      mu.full_name AS marketer_name
    FROM customers c
    JOIN users cu ON cu.user_id = c.user_id
    LEFT JOIN marketers m ON m.marketer_id = c.marketer_id
    LEFT JOIN users mu ON mu.user_id = m.user_id
    WHERE c.customer_id = ?
    `,
    [customerId]
  );

  if (!rows.length) return { customer_name: null, marketer_name: null };
  return {
    customer_name: rows[0].customer_name,
    marketer_name: rows[0].marketer_name,
  };
};