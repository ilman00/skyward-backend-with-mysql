// src/services/notificationRecipientService.ts
import { pool } from "../config/db"; // adjust to your actual pool import
import { RowDataPacket } from "mysql2";

export const getActiveRecipientEmails = async (): Promise<string[]> => {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT email FROM notification_recipients WHERE is_active = 1`
  );
  return rows.map((r) => r.email);
};