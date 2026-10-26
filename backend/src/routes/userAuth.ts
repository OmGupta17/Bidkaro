import jwt from "jsonwebtoken";
import { requireUser, type UserRequest } from "../middleware/requireUser";
import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db";

const router = Router();

router.post("/register", async (req: Request, res: Response) => {
  try {
    const { full_name, email, phone, password } = req.body ?? {};

    // Validate required input types
    if (
      typeof full_name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      (phone !== undefined && phone !== null && typeof phone !== "string")
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid registration details."
      });
      return;
    }

    const name = full_name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = (phone ?? "").trim();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (name.length < 2 || name.length > 150) {
      res.status(400).json({
        success: false,
        message: "Name must contain 2 to 150 characters."
      });
      return;
    }

    if (
      normalizedEmail.length > 255 ||
      !emailRegex.test(normalizedEmail)
    ) {
      res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
      return;
    }

    if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
      res.status(400).json({
        success: false,
        message: "Password must be at least 12 characters and at most 72 UTF-8 bytes."
      });
      return;
    }

    if (
      normalizedPhone &&
      !/^\+?[0-9]{10,15}$/.test(normalizedPhone)
    ) {
      res.status(400).json({
        success: false,
        message: "Enter a valid phone number."
      });
      return;
    }

    // Password securely hashed before storage
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (
        full_name,
        email,
        phone,
        password_hash,
        role,
        is_active,
        is_email_verified,
        kyc_status
      )
      VALUES ($1, $2, $3, $4, 'USER', TRUE, FALSE, 'NOT_SUBMITTED')
      RETURNING id, full_name, email, phone, role,
                is_email_verified, kyc_status, created_at`,
      [
        name,
        normalizedEmail,
        normalizedPhone || null,
        passwordHash
      ]
    );

    res.status(201).json({
      success: true,
      message: "Account created successfully.",
      user: result.rows[0]
    });

  } catch (error: unknown) {
    // PostgreSQL unique constraint violation
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
      return;
    }

    console.error("USER REGISTRATION ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create account right now."
    });
  }
});


// USER LOGIN
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password
    ) {
      res.status(400).json({
        success: false,
        message: "Email and password are required."
      });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (normalizedEmail.length > 255 || password.length > 1024) {
      res.status(400).json({
        success: false,
        message: "Invalid login details."
      });
      return;
    }

    const result = await pool.query(
      `SELECT id, full_name, email, phone,
              password_hash, role, is_active,
              is_email_verified, kyc_status
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [normalizedEmail]
    );

    const user = result.rows[0];

    // Always run a bcrypt comparison to reduce account enumeration.
    const dummyHash =
      "$2b$12$C6UzMDM.H6dfI/f/IKcEeO6fYslhG6i0eKQeKp5sN7kYM/q8XnH4a";

    const validPassword = await bcrypt.compare(
      password,
      user?.password_hash ?? dummyHash
    );

    if (
      !user ||
      !validPassword ||
      !user.is_active ||
      user.role !== "USER"
    ) {
      res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
      return;
    }

    const secret = process.env.USER_JWT_SECRET;

    if (!secret) {
      throw new Error("USER_JWT_SECRET missing");
    }

    const token = jwt.sign(
      {
        role: "USER",
        tokenType: "user_access"
      },
      secret,
      {
        subject: String(user.id),
        issuer: "zameene-user-api",
        audience: "zameene-user",
        algorithm: "HS256",
        expiresIn: "2h"
      }
    );

    // BIDKARO_COOKIE_SESSION: retain the existing JSON token for Next.js clients.
    res.cookie("bidkaro_user_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api",
      maxAge: 2 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      message: "Login successful.",
      accessToken: token,
      expiresIn: 7200,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        is_email_verified: user.is_email_verified,
        kyc_status: user.kyc_status
      }
    });
  } catch (error) {
    console.error("USER LOGIN ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to login right now."
    });
  }
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie("bidkaro_user_session", { path: "/api", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  res.json({ success: true });
});

// PROTECTED CURRENT USER
router.get("/me", requireUser, async (req: UserRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, phone, role,
              is_email_verified, kyc_status, created_at
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [req.authenticatedUser!.id]
    );

    if (!result.rowCount) {
      res.status(401).json({
        success: false,
        message: "User not found."
      });
      return;
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error("USER ME ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load profile."
    });
  }
});

export default router;
