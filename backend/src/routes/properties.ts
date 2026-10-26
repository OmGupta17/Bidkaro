import { Router, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db";
import multer from "multer";
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";

const router = Router();

type AdminRequest = Request & {
  adminId?: string;
};

async function requireAdmin(
  req: AdminRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Login required" });
    return;
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT secret missing");

    const decoded = jwt.verify(header.slice(7), secret, {
      algorithms: ["HS256"],
    });

    if (
      typeof decoded === "string" ||
      typeof decoded.sub !== "string"
    ) {
      res.status(401).json({ message: "Invalid session" });
      return;
    }

    const result = await pool.query(
      `SELECT id FROM admin_users
       WHERE id = $1 AND is_active = TRUE
       AND role IN ('ADMIN', 'SUPER_ADMIN')`,
      [decoded.sub]
    );

    if (!result.rowCount) {
      res.status(403).json({ message: "Access denied" });
      return;
    }

    req.adminId = decoded.sub;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired session" });
  }
}

router.use(requireAdmin);
const photoUpload = multer({ storage: multer.memoryStorage(), limits: {files:15,fileSize:5*1024*1024} });
const csvUpload = multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024}});
const imageDirectory = path.resolve(process.cwd(),"uploads/properties");

// Uploads are private until the property is APPROVED.
router.post("/:id/photos", photoUpload.array("photos",15), async (req,res) => {
  const id = String(req.params.id);
  if (!/^[1-9]\d*$/.test(id)) return res.status(400).json({message:"Invalid property ID"});
  const files = (req.files || []) as Express.Multer.File[];
  if (!files.length) return res.status(400).json({message:"Select photos"});
  const client = await pool.connect();
  const saved: string[] = [];
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT id FROM properties WHERE id=$1 FOR UPDATE",[id]);
    if (!exists.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({message:"Property not found"}); }
    const count = await client.query("SELECT COUNT(*)::int AS n FROM property_images WHERE property_id=$1",[id]);
    if (count.rows[0].n+files.length>15) {await client.query("ROLLBACK");return res.status(400).json({message:"Maximum 15 photos"});}
    await fs.mkdir(imageDirectory,{recursive:true});
    for (const file of files) {
      // Sharp decodes the image rather than trusting the MIME or extension.
      const bytes = await sharp(file.buffer,{limitInputPixels:40000000}).rotate().resize({width:1800,withoutEnlargement:true}).webp({quality:82}).toBuffer();
      const name = randomUUID()+".webp";
      await fs.writeFile(path.join(imageDirectory,name),bytes,{flag:"wx"}); saved.push(name);
      await client.query(`INSERT INTO property_images (property_id,storage_key,mime_type,sort_order)
        VALUES ($1,$2,'image/webp',(SELECT COALESCE(MAX(sort_order)+1,0) FROM property_images WHERE property_id=$1))`,[id,name]);
    }
    await client.query("COMMIT");
    return res.status(201).json({success:true,uploaded:saved.length});
  } catch(e) {
    await client.query("ROLLBACK").catch(()=>{});
    await Promise.all(saved.map(n=>fs.unlink(path.join(imageDirectory,n)).catch(()=>{})));
    console.error("Admin photo upload failed",e);
    return res.status(500).json({message:"Photo upload failed; existing property retained"});
  } finally {client.release();}
});

// Bulk CSV import: atomic, validated, no auto-approval; optional fields default to empty.
router.post("/bulk/import",csvUpload.single("file"),async(req:AdminRequest,res)=>{
  if(!req.file)return res.status(400).json({message:"CSV required"});
  let rows:Record<string,string>[];
  try { rows=parse(req.file.buffer.toString("utf8"),{columns:true,bom:true,trim:true,skip_empty_lines:true}) as Record<string,string>[]; }
  catch {return res.status(400).json({message:"Invalid CSV"});}
  if(rows.length<1||rows.length>500)return res.status(400).json({message:"Use 1–500 rows"});
  const errors:string[]=[];
  rows.forEach((r,i)=>{
    if(!r.title||r.title.length>255||!r.city||r.city.length>100||
       !["APARTMENT","HOUSE","VILLA","PLOT","COMMERCIAL"].includes(r.property_type)||
       !["SALE","RENT","AUCTION"].includes(r.listing_type)||
       !r.price||!Number.isFinite(Number(r.price))||Number(r.price)<0||Number(r.price)>9999999999999||
       (r.area_sqft!==undefined&&r.area_sqft!==""&&(!Number.isFinite(Number(r.area_sqft))||Number(r.area_sqft)<=0))||
       [r.bedrooms,r.bathrooms].some(v=>v!==undefined&&v!==""&&(!Number.isInteger(Number(v))||Number(v)<0))) errors.push(`Row ${i+2}: invalid required field`);
  });
  if(errors.length)return res.status(400).json({message:"Validation failed",errors:errors.slice(0,100)});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const ids:string[]=[];
    for(const r of rows){
      const result=await client.query(`INSERT INTO properties
       (title,property_type,listing_type,description,price,area_sqft,bedrooms,bathrooms,address,city,state,pincode,owner_name,owner_phone,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PENDING',$15) RETURNING id`,[
       r.title,r.property_type,r.listing_type,r.description||'',Number(r.price),r.area_sqft?Number(r.area_sqft):null,
       r.bedrooms?Number(r.bedrooms):null,r.bathrooms?Number(r.bathrooms):null,r.address||'',r.city,r.state||'',r.pincode||'',r.owner_name||'',r.owner_phone||'',req.adminId]);
      ids.push(String(result.rows[0].id));
    }
    await client.query("COMMIT");return res.status(201).json({success:true,imported:ids.length,propertyIds:ids});
  }catch(e){await client.query("ROLLBACK").catch(()=>{});console.error("Bulk import",e);return res.status(500).json({message:"Import rolled back; check required DB columns"});}
  finally{client.release();}
});


// GET ALL PROPERTIES
router.get("/", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              u.full_name AS submitted_by_name,
              u.email AS submitted_by_email,
              (SELECT COUNT(*)::integer
               FROM property_images i
               WHERE i.property_id = p.id) AS image_count
       FROM properties p
       LEFT JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC`
    );

    res.json({ success: true, properties: result.rows });
  } catch (error) {
    console.error("Property list error:", error);
    res.status(500).json({ message: "Failed to load properties" });
  }
});

// ADD NEW PROPERTY
router.post("/", async (req: AdminRequest, res) => {
  try {
    const {
      title, property_type, listing_type,
      description, price, area_sqft,
      bedrooms, bathrooms, address,
      city, state, pincode,
      owner_name, owner_phone
    } = req.body ?? {};

    const text = (v: unknown) =>
      typeof v === "string" ? v.trim() : "";

    const titleValue = text(title);
    const typeValue = text(property_type);
    const listingValue = text(listing_type);
    const cityValue = text(city);

    const numeric = (v: unknown, integer = false) => {
      if (v === "" || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) &&
        (!integer || Number.isInteger(n)) ? n : NaN;
    };

    const priceValue = numeric(price);
    const areaValue = numeric(area_sqft);
    const bedValue = numeric(bedrooms, true);
    const bathValue = numeric(bathrooms, true);

    if (
      !titleValue || titleValue.length > 255 ||
      !cityValue || cityValue.length > 100 ||
      !["APARTMENT", "HOUSE", "VILLA", "PLOT", "COMMERCIAL"].includes(typeValue) ||
      !["SALE", "RENT", "AUCTION"].includes(listingValue) ||
      priceValue === null || !Number.isFinite(priceValue) ||
      priceValue < 0 || priceValue > 9999999999999 ||
      (areaValue !== null && (!Number.isFinite(areaValue) || areaValue <= 0)) ||
      [bedValue, bathValue].some(
        n => n !== null && (!Number.isFinite(n) || n < 0)
      )
    ) {
      res.status(400).json({ message: "Invalid property details" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO properties (
        title, property_type, listing_type,
        description, price, area_sqft,
        bedrooms, bathrooms, address,
        city, state, pincode,
        owner_name, owner_phone,
        status, created_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,
        'PENDING',$15
      ) RETURNING *`,
      [
        titleValue, typeValue, listingValue,
        text(description), priceValue, areaValue,
        bedValue, bathValue, text(address),
        cityValue, text(state), text(pincode),
        text(owner_name), text(owner_phone),
        req.adminId
      ]
    );

    res.status(201).json({
      success: true,
      message: "Property submitted for approval",
      property: result.rows[0]
    });
  } catch (error) {
    console.error("Create property error:", error);
    res.status(500).json({ message: "Failed to create property" });
  }
});

// APPROVE OR REJECT PROPERTY
router.patch("/:id/status", async (req: AdminRequest, res) => {
  try {
    const id = req.params.id;
    const { status, rejection_reason } = req.body ?? {};

    if (!/^[1-9]\d*$/.test(String(id))) {
      res.status(400).json({ message: "Invalid property ID" });
      return;
    }

    if (!["APPROVED", "REJECTED"].includes(status)) {
      res.status(400).json({ message: "Invalid status" });
      return;
    }

    const reason = typeof rejection_reason === "string"
      ? rejection_reason.trim()
      : "";

    if (status === "REJECTED" && (!reason || reason.length > 2000)) {
      res.status(400).json({
        message: "Rejection reason required (maximum 2000 characters)"
      });
      return;
    }

    const result = await pool.query(
      `UPDATE properties
       SET status = $1,
           rejection_reason = $2,
           reviewed_by = $3,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $4 AND status = 'PENDING'
       RETURNING *`,
      [
        status,
        status === "REJECTED" ? reason : null,
        req.adminId,
        id
      ]
    );

    if (!result.rowCount) {
      res.status(409).json({
        message: "Property not found or already reviewed"
      });
      return;
    }

    res.json({
      success: true,
      message: `Property ${status.toLowerCase()}`,
      property: result.rows[0]
    });
  } catch (error) {
    console.error("Property review error:", error);
    res.status(500).json({ message: "Review failed" });
  }
});

export default router;
