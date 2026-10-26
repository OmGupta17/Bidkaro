import { Router, type Response } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { pool } from "../db";
import {
  requireUser,
  type UserRequest
} from "../middleware/requireUser";

const router = Router();
router.use(requireUser);

const uploadDir = path.resolve(
  process.cwd(), "uploads/properties"
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
    fileSize: 5 * 1024 * 1024,
    fields: 20,
    fieldSize: 10000
  }
});

function imageType(buffer: Buffer) {
  if (
    buffer.length >= 3 &&
    buffer.subarray(0, 3).equals(
      Buffer.from([0xff, 0xd8, 0xff])
    )
  ) return { mime: "image/jpeg", ext: ".jpg" };

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) return { mime: "image/png", ext: ".png" };

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) return { mime: "image/webp", ext: ".webp" };

  return null;
}

// USER: MY PROPERTIES
router.get("/", async (req: UserRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.title, p.property_type,
              p.listing_type, p.price, p.city,
              p.status, p.rejection_reason,
              p.created_at,
              COUNT(i.id)::integer AS image_count
       FROM properties p
       LEFT JOIN property_images i ON i.property_id = p.id
       WHERE p.user_id = $1
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [req.authenticatedUser!.id]
    );

    res.json({
      success: true,
      properties: result.rows
    });
  } catch (error) {
    console.error("MY PROPERTIES ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load properties"
    });
  }
});

// USER: CREATE PROPERTY
router.post(
  "/",
  upload.array("images", 5),
  async (req: UserRequest, res: Response) => {
    const files = (req.files ?? []) as Express.Multer.File[];
    const savedPaths: string[] = [];
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      const data = req.body ?? {};
      const str = (v: unknown) =>
        typeof v === "string" ? v.trim() : "";

      const title = str(data.title);
      const city = str(data.city);
      const propertyType = str(data.property_type);
      const listingType = str(data.listing_type);

      const priceText = str(data.price);
      const price = Number(priceText);

      const areaText = str(data.area_sqft);
      const area = areaText ? Number(areaText) : null;

      const bedroomsText = str(data.bedrooms);
      const bathroomsText = str(data.bathrooms);
      const bedrooms = bedroomsText ? Number(bedroomsText) : null;
      const bathrooms = bathroomsText ? Number(bathroomsText) : null;

      const optionalText = [
        ["description", 10000],
        ["address", 2000],
        ["state", 100],
        ["pincode", 10]
      ] as const;

      const validOptional = optionalText.every(
        ([key, max]) => str(data[key]).length <= max
      );

      if (
        title.length < 5 || title.length > 255 ||
        !city || city.length > 100 ||
        !["APARTMENT", "HOUSE", "VILLA", "PLOT", "COMMERCIAL"]
          .includes(propertyType) ||
        !["SALE", "RENT", "AUCTION"].includes(listingType) ||
        !priceText ||
        !Number.isFinite(price) ||
        price < 0 || price > 9999999999999 ||
        (area !== null &&
          (!Number.isFinite(area) || area <= 0 || area > 9999999999)) ||
        [bedrooms, bathrooms].some(
          n => n !== null &&
          (!Number.isInteger(n) || n < 0 || n > 100)
        ) ||
        !validOptional ||
        files.length > 5
      ) {
        res.status(400).json({
          success: false,
          message: "Invalid property details"
        });
        return;
      }

      const types = files.map(f => imageType(f.buffer));

      if (types.some(t => !t)) {
        res.status(400).json({
          success: false,
          message: "Only valid JPG, PNG or WebP images allowed"
        });
        return;
      }

      await fs.mkdir(uploadDir, { recursive: true });

      await client.query("BEGIN");
      transactionStarted = true;

      const result = await client.query(
        `INSERT INTO properties (
          title, property_type, listing_type,
          description, price, area_sqft,
          bedrooms, bathrooms, address,
          city, state, pincode,
          status, user_id
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,'PENDING',$13
        ) RETURNING id, title, status, user_id`,
        [
          title, propertyType, listingType,
          str(data.description), price, area,
          bedrooms, bathrooms, str(data.address),
          city, str(data.state), str(data.pincode),
          req.authenticatedUser!.id
        ]
      );

      const property = result.rows[0];

      for (let i = 0; i < files.length; i++) {
        const type = types[i]!;
        const filename = crypto.randomUUID() + type.ext;
        const filepath = path.join(uploadDir, filename);

        await fs.writeFile(filepath, files[i].buffer, {
          flag: "wx"
        });
        savedPaths.push(filepath);

        await client.query(
          `INSERT INTO property_images
           (property_id, storage_key, mime_type, sort_order)
           VALUES ($1, $2, $3, $4)`,
          [property.id, filename, type.mime, i]
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;

      res.status(201).json({
        success: true,
        message: "Property submitted for admin verification",
        property,
        imageCount: files.length
      });
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(console.error);
      }

      await Promise.all(
        savedPaths.map(p => fs.unlink(p).catch(console.error))
      );

      console.error("CREATE PROPERTY ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Unable to submit property"
      });
    } finally {
      client.release();
    }
  }
);

export default router;
