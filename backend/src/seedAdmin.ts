import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./db";
import { createInterface } from "node:readline/promises";

async function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const name = (await rl.question("Admin name: ")).trim();
    const email = (await rl.question("Admin email: ")).trim().toLowerCase();
    const password = await rl.question("Admin password: ");

    if (!name || !email || password.length < 12) {
      throw new Error("Name/email required and password must have at least 12 characters.");
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO admin_users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'SUPER_ADMIN')
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email`,
      [name, email, hash]
    );

    if (result.rowCount === 0) {
      console.log("Admin already exists. No changes made.");
    } else {
      console.log("Admin created:", result.rows[0].email);
    }
  } finally {
    rl.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
