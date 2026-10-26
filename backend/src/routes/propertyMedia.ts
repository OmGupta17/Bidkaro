import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import sharp from "sharp";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";
import { pool } from "../db";

const router = Router();

const bucket = process.env.S3_BUCKET ?? "";
const s3 = new S3Client({
  region: process.env.S3_REGION ?? "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? ""
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 15 }
});

type AdminRequest = Request & { adminId?: string };

async function requireAdmin(
  req: AdminRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token || !process.env.JWT_SECRET) {
      res.status(401).json({ error: "Admin login required" });
      return;
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"]
    });

    if (typeof payload === "string" || !payload.sub) {
      res.status(401).json({ error: "Invalid admin token" });
      return;
    }

    const result = await pool.query(
      "SELECT id FROM admin_users WHERE id=$1 AND is_active=TRUE",
      [payload.sub]
    );

    if (!result.rowCount) {
      res.status(403).json({ error: "Admin access denied" });
      return;
    }

    req.adminId = String(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired admin session" });
  }
}

router.post(
  "/:propertyId/photos",
  requireAdmin,
  upload.array("photos", 15),
  async (req: AdminRequest, res) => {
    const propertyId = req.params.propertyId;
    const files = (req.files ?? []) as Express.Multer.File[];

    if (!/^\d+$/.test(String(propertyId))) {
      return res.status(400).json({ error: "Invalid property ID" });
    }

    if (!files.length) {
      return res.status(400).json({ error: "Select photos first" });
    }

    const property = await pool.query(
      "SELECT id FROM properties WHERE id=$1",
      [propertyId]
    );

    if (!property.rowCount) {
      return res.status(404).json({ error: "Property not found" });
    }

    const count = await pool.query(
      "SELECT COUNT(*)::int AS total FROM property_photos WHERE property_id=$1",
      [propertyId]
    );

    if (count.rows[0].total + files.length > 15) {
      return res.status(400).json({ error: "Maximum 15 photos per property" });
    }

    const uploaded: Array<{ id: string; url: string }> = [];

    try {
      for (const file of files) {
        const image = await sharp(file.buffer, {
          limitInputPixels: 40000000
        })
          .rotate()
          .resize({ width: 1800, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();

        const key = `properties/${propertyId}/${randomUUID()}.webp`;

        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: image,
          ContentType: "image/webp"
        }));

        try {
          const saved = await pool.query(
            `INSERT INTO property_photos
              (property_id, object_key, mime_type, sort_order, is_cover)
             VALUES (
               $1, $2, 'image/webp',
               COALESCE(
                 (SELECT MAX(sort_order)+1 FROM property_photos WHERE property_id=$1),
                 0
               ),
               NOT EXISTS (
                 SELECT 1 FROM property_photos WHERE property_id=$1
               )
             )
             RETURNING id`,
            [propertyId, key]
          );

          uploaded.push({
            id: String(saved.rows[0].id),
            url: `/api/admin/media/${saved.rows[0].id}`
          });
        } catch (error) {
          await s3.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: key
          })).catch(() => {});
          throw error;
        }
      }

      return res.status(201).json({ success: true, photos: uploaded });
    } catch (error) {
      console.error("Property upload failed", error);
      return res.status(500).json({
        error: "Some photos may have uploaded. Refresh the gallery before retrying."
      });
    }
  }
);

router.get("/:propertyId/photos", requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT id, is_cover, sort_order
     FROM property_photos
     WHERE property_id=$1
     ORDER BY sort_order, id`,
    [req.params.propertyId]
  );

  res.json({
    photos: result.rows.map(p => ({
      ...p,
      url: `/api/admin/media/${p.id}`
    }))
  });
});

router.post("/:propertyId/cover/:photoId", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const photo = await client.query(
      "SELECT id FROM property_photos WHERE id=$1 AND property_id=$2",
      [req.params.photoId, req.params.propertyId]
    );

    if (!photo.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Photo not found" });
    }

    await client.query(
      "UPDATE property_photos SET is_cover=FALSE WHERE property_id=$1",
      [req.params.propertyId]
    );

    await client.query(
      "UPDATE property_photos SET is_cover=TRUE WHERE id=$1",
      [req.params.photoId]
    );

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: "Unable to set cover" });
  } finally {
    client.release();
  }
});

router.delete("/:propertyId/photos/:photoId", requireAdmin, async (req, res) => {
  const result = await pool.query(
    `DELETE FROM property_photos
     WHERE id=$1 AND property_id=$2
     RETURNING object_key`,
    [req.params.photoId, req.params.propertyId]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Photo not found" });
  }

  await s3.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: result.rows[0].object_key
  }));

  res.json({ success: true });
});

export default router;
