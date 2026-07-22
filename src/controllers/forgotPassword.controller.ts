import { Request, Response } from "express";
import { pool } from "../config/db";
import { transporter } from "../config/nodemailer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { createAccessToken, createRefreshToken } from "../utils/jwt";


export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Check user exists
    // NOTE: $1 -> ?
    const [userRows] = await pool.query(
      "SELECT user_id FROM users WHERE email = ?",
      [normalizedEmail]
    );

    if ((userRows as any[]).length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // 2. Check existing OTP
    const [existingOtpRows] = await pool.query(
      `
      SELECT * FROM otps
      WHERE email = ? AND purpose = 'reset_password'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [normalizedEmail]
    );

    if ((existingOtpRows as any[]).length > 0) {
      const otpRow = (existingOtpRows as any[])[0];

      // Block check
      if (otpRow.block_until && new Date(otpRow.block_until) > new Date()) {
        return res.status(429).json({
          message: "Too many requests. Please try later."
        });
      }

      // Resend limit example
      if (otpRow.resend_count >= 5) {
        // NOTE: NOW() + INTERVAL '15 minutes' -> DATE_ADD(NOW(), INTERVAL 15 MINUTE)
        await pool.query(
          `UPDATE otps SET block_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE otp_id = ?`,
          [otpRow.otp_id]
        );
        return res.status(429).json({
          message: "OTP resend limit reached. Try again later."
        });
      }
    }

    // 3. Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // 4. Upsert OTP
    // ⚠️ IMPORTANT WATCH-OUT: Postgres's `ON CONFLICT (email, purpose)`
    // requires a UNIQUE constraint or index on exactly those two columns to
    // know what counts as a "conflict." Looking at your schema, the `otps`
    // table has NO unique constraint on (email, purpose) at all — so this
    // ON CONFLICT clause would only have worked in Postgres if that
    // constraint was added manually outside the Prisma schema (the schema
    // comments do mention "check constraints... requires additional setup
    // for migrations," so it's possible this exists in the live DB but
    // isn't reflected in schema.prisma).
    //
    // MySQL's equivalent, `ON DUPLICATE KEY UPDATE`, has the exact same
    // requirement — it only triggers on a UNIQUE or PRIMARY KEY violation.
    // You MUST add this before this query will behave as an upsert instead
    // of always inserting a new row:
    //
    //   ALTER TABLE otps ADD UNIQUE KEY uq_otps_email_purpose (email, purpose);
    //
    // Also note: MySQL's `EXCLUDED.column` (the "value that was about to be
    // inserted") has a different name — `VALUES(column)` in older
    // MySQL/MariaDB syntax, or the row alias in MySQL 8.0.19+. I'm using
    // `VALUES()` here since it's the form both MySQL and MariaDB support
    // across all recent versions.
    await pool.query(
      `
      INSERT INTO otps (otp_id, email, otp, purpose, expires_at)
      VALUES (?, ?, ?, 'reset_password', ?)
      ON DUPLICATE KEY UPDATE
        otp = VALUES(otp),
        expires_at = VALUES(expires_at),
        resend_count = resend_count + 1,
        last_sent = NOW(),
        attempts = 0,
        block_until = NULL
      `,
      [crypto.randomUUID(), normalizedEmail, otp, expiresAt]
    );

    // 5. Send email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: normalizedEmail,
      subject: "Password Reset OTP",
      html: `<p>Your OTP is <b>${otp}</b>. It expires in 10 minutes.</p>`
    });

    return res.status(200).json({ message: "OTP sent to email" });

  } catch (error: any) {
    console.error(error);
    return res.status(500).json({
      message: "Server error",
      error: error.message
    });
  }
};



export const verifyForgotOtp = async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const [otpRows] = await pool.query(
      `
      SELECT *
      FROM otps
      WHERE email = ? AND purpose = 'reset_password'
      LIMIT 1
      `,
      [normalizedEmail]
    );

    if ((otpRows as any[]).length === 0) {
      return res.status(400).json({ message: "OTP not found" });
    }

    const record = (otpRows as any[])[0];

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    if (record.otp !== String(otp)) {
      await pool.query(
        `UPDATE otps SET attempts = attempts + 1 WHERE otp_id = ?`,
        [record.otp_id]
      );
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // OTP valid → delete OTP
    await pool.query(
      `DELETE FROM otps WHERE email = ? AND purpose = 'reset_password'`,
      [normalizedEmail]
    );

    // 🔑 Issue RESET JWT — no DB involved, unchanged
    const resetToken = jwt.sign(
      {
        email: normalizedEmail,
        purpose: "reset_password"
      },
      process.env.JWT_SECRET!,
      { expiresIn: "10m" }
    );

    return res.status(200).json({
      message: "OTP verified",
      resetToken
    });

  } catch (error: any) {
    return res.status(500).json({ message: "Server error" });
  }
};


export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { newPassword, resetToken } = req.body;

    if (!newPassword || !resetToken) {
      return res.status(400).json({
        message: "New password and reset token required"
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters long"
      });
    }

    // 1. Verify JWT — unchanged, no DB
    let payload: any;
    try {
      payload = jwt.verify(resetToken, process.env.JWT_SECRET!);
    } catch {
      return res.status(401).json({
        message: "Invalid or expired reset token"
      });
    }

    if (payload.purpose !== "reset_password" || !payload.email) {
      return res.status(401).json({
        message: "Invalid reset token"
      });
    }

    const normalizedEmail = payload.email;

    // 2. Update password
    const hash = await bcrypt.hash(newPassword, 10);

    // NOTE: $1, $2 -> ?, ?
    const [result] = await pool.query(
      `
      UPDATE users
      SET password_hash = ?,
          updated_at = NOW()
      WHERE email = ?
      `,
      [hash, normalizedEmail]
    );

    // NOTE: rowCount -> affectedRows, same ResultSetHeader pattern as the
    // delete handlers earlier
    if ((result as any).affectedRows === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      message: "Password reset successful"
    });

  } catch (error: any) {
    return res.status(500).json({ message: "Server error" });
  }
};