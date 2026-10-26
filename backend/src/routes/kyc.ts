import { Router, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db";
import { requireUser, type UserRequest } from "../middleware/requireUser";

const router = Router();
const statuses = new Set(["PENDING", "VERIFIED", "FAILED", "EXPIRED"]);

router.get("/me", requireUser, async (req: UserRequest, res) => {
  const result = await pool.query("SELECT status, verified_at, updated_at FROM user_kyc WHERE user_id=$1", [req.authenticatedUser!.id]);
  res.json({ success: true, kyc: result.rows[0] ?? { status: "NOT_STARTED", verified_at: null } });
});

// The actual OTP start/confirm calls MUST be supplied by an authorized provider's documented SDK.
// No Aadhaar number, OTP or document image is accepted or stored by this API.
router.post("/start", requireUser, async (_req: UserRequest, res) => {
  res.status(503).json({
    success: false,
    message: "Aadhaar OTP provider is not connected. Verification cannot start yet."
  });
});

// Admin JWT is verified separately from the user session.
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !process.env.JWT_SECRET) { res.status(401).json({ message: "Admin login required" }); return; }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || !decoded.sub || !("role" in decoded)) {
      res.status(401).json({ message: "Invalid admin session" }); return;
    }
    const found = await pool.query("SELECT id FROM admin_users WHERE id=$1 AND role=$2 AND is_active=TRUE", [decoded.sub, decoded.role]);
    if (!found.rowCount) { res.status(403).json({ message: "Forbidden" }); return; }
    next();
  } catch { res.status(401).json({ message: "Invalid admin session" }); }
}

router.get("/admin/review", requireAdmin, async (_req, res) => {
  const result = await pool.query(`
    SELECT u.id, u.full_name, u.email,
           COALESCE(k.status,'NOT_STARTED') AS kyc_status,
           k.provider, k.verified_at, k.updated_at
    FROM users u LEFT JOIN user_kyc k ON k.user_id=u.id
    ORDER BY k.updated_at DESC NULLS LAST, u.id DESC LIMIT 100
  `);
  res.json({ success: true, users: result.rows });
});

// No manual "mark verified" endpoint: only verified provider evidence may change KYC status.
// Provider-specific callback/signature verification will be added after choosing the provider.
export default router;
