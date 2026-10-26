import {
  type Request,
  type Response,
  type NextFunction
} from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { pool } from "../db";

export type UserRequest = Request & {
  authenticatedUser?: {
    id: string;
    role: "USER";
  };
};

export async function requireUser(
  req: UserRequest,
  res: Response,
  next: NextFunction
) {
  const authorization = req.headers.authorization;
  const cookieValue = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("bidkaro_user_session="));
  const cookieToken = cookieValue?.slice("bidkaro_user_session=".length);
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  // Cookie-based mutations must come from the same origin (CSRF protection).
  if (!bearerToken && cookieToken && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.origin;
    const expected = `${req.protocol}://${req.get("host")}`;
    const allowed = new Set([expected, process.env.BIDKARO_ORIGIN].filter(Boolean));
    if (!origin || !allowed.has(origin)) {
      res.status(403).json({ success: false, message: "Origin not allowed." });
      return;
    }
  }

  if (!bearerToken && !cookieToken) {
    res.status(401).json({
      success: false,
      message: "Authentication required."
    });
    return;
  }

  try {
    const secret = process.env.USER_JWT_SECRET;

    if (!secret) {
      throw new Error("User JWT secret missing");
    }

    const token = bearerToken ?? cookieToken!;

    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: "zameene-user-api",
      audience: "zameene-user"
    }) as JwtPayload;

    if (
      typeof payload.sub !== "string" ||
      payload.role !== "USER" ||
      payload.tokenType !== "user_access"
    ) {
      res.status(401).json({
        success: false,
        message: "Invalid authentication token."
      });
      return;
    }

    const result = await pool.query(
      `SELECT id, role
       FROM users
       WHERE id = $1
         AND role = 'USER'
         AND is_active = TRUE`,
      [payload.sub]
    );

    if (!result.rowCount) {
      res.status(401).json({
        success: false,
        message: "User account unavailable."
      });
      return;
    }

    req.authenticatedUser = {
      id: String(result.rows[0].id),
      role: "USER"
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        success: false,
        message: "Invalid or expired session."
      });
      return;
    }

    console.error("USER AUTH ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to verify session."
    });
  }
}
