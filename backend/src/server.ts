import kycRouter from "./routes/kyc";
import publicPropertiesRouter from "./routes/publicProperties";
import propertyAccessRouter from "./routes/propertyAccess";
import userPropertyRoutes from "./routes/userProperties";
import userAuthRoutes from "./routes/userAuth";
import propertyRoutes from "./routes/properties";
import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "./db";

const app = express();

const PORT = Number(process.env.PORT || 5001);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET is missing or too short.");
}

app.use(cors({
  origin: process.env.FRONTEND_URL,
}));

app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "Zameene Property Marketplace API is running",
  });
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash, role, is_active
       FROM admin_users
       WHERE email = $1
       LIMIT 1`,
      [email.trim().toLowerCase()]
    );

    const admin = result.rows[0];

    if (!admin || !admin.is_active) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const token = jwt.sign(
      {
        sub: String(admin.id),
        role: admin.role,
      },
      JWT_SECRET,
      { expiresIn: "2h", algorithm: "HS256" }
    );

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error("Admin login error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.use("/api/admin/properties", propertyRoutes);

app.use("/api/users", userAuthRoutes);
app.use("/api/kyc", kycRouter);

app.use("/api/user/properties", userPropertyRoutes);
app.use("/api/access", propertyAccessRouter);

async function startServer() {
  await pool.query("SELECT 1");

  app.use("/api/public/properties", publicPropertiesRouter);

app.listen(PORT, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
    console.log("PostgreSQL connected successfully");
  });
}

app.get("/api/admin/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const token = authHeader.slice(7);

    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    });

    if (typeof decoded === "string" || !decoded.sub) {
      return res.status(401).json({
        success: false,
        message: "Invalid token.",
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, role
       FROM admin_users
       WHERE id = $1 AND is_active = TRUE`,
      [decoded.sub]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        success: false,
        message: "Admin not found.",
      });
    }

    return res.json({
      success: true,
      admin: result.rows[0],
    });
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired session.",
    });
  }
});

startServer().catch((error) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
