import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { pool } from "../db";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }
});

router.post("/import", upload.single("file"), async (req, res) => {
  // IMPORTANT: This route must be mounted behind existing
  // verified admin authentication. Never mount publicly.
  if (!req.file) {
    return res.status(400).json({ error: "CSV file required" });
  }

  try {
    const records = parse(req.file.buffer.toString("utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    }) as Record<string, string>[];

    if (!records.length || records.length > 500) {
      return res.status(400).json({
        error: "CSV must contain 1 to 500 properties"
      });
    }

    const required = [
      "title", "property_type", "listing_type",
      "price", "area_sqft", "city", "state"
    ];

    const errors: string[] = [];

    records.forEach((row, index) => {
      const line = index + 2;

      for (const field of required) {
        if (!row[field]?.trim()) {
          errors.push(`Row ${line}: ${field} is required`);
        }
      }

      if (
        !Number.isFinite(Number(row.price)) ||
        Number(row.price) <= 0
      ) {
        errors.push(`Row ${line}: invalid price`);
      }

      if (
        !Number.isFinite(Number(row.area_sqft)) ||
        Number(row.area_sqft) <= 0
      ) {
        errors.push(`Row ${line}: invalid area`);
      }
    });

    if (errors.length) {
      return res.status(400).json({
        success: false,
        errors: errors.slice(0, 100)
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const createdIds: string[] = [];

      for (const row of records) {
        const result = await client.query(
          `INSERT INTO properties (
            title, property_type, listing_type, price,
            area_sqft, bedrooms, bathrooms, city, state,
            pincode, status
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING'
          ) RETURNING id`,
          [
            row.title,
            row.property_type,
            row.listing_type,
            Number(row.price),
            Number(row.area_sqft),
            Number(row.bedrooms || 0),
            Number(row.bathrooms || 0),
            row.city,
            row.state,
            row.pincode || null
          ]
        );

        createdIds.push(String(result.rows[0].id));
      }

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        imported: createdIds.length,
        propertyIds: createdIds
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Bulk import failed", error);
      return res.status(500).json({
        error: "Bulk import failed. Database changes rolled back."
      });
    } finally {
      client.release();
    }
  } catch {
    return res.status(400).json({ error: "Invalid CSV file" });
  }
});

export default router;
