import { Router } from "express";
import { pool } from "../db";
import fs from "node:fs/promises";
import path from "node:path";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        title,
        property_type,
        listing_type,
        price,
        area_sqft,
        bedrooms,
        bathrooms,
        city,
        state,
        status,
        created_at,
        (SELECT i.id FROM property_images i WHERE i.property_id=properties.id ORDER BY i.sort_order,i.id LIMIT 1) AS cover_image_id
      FROM properties
      WHERE status = 'APPROVED'
      ORDER BY created_at DESC
      LIMIT 100
    `);

    res.json({
      success: true,
      properties: result.rows.map(row=>({...row,
        image_url: row.cover_image_id ? `/api/public/properties/images/${row.cover_image_id}` : null
      })),
    });
  } catch (error) {
    console.error("Public properties error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load properties",
    });
  }
});

// Never serve unapproved photos, and never accept a filename from the browser.
router.get("/images/:imageId", async(req,res)=>{
  if(!/^[1-9]\d*$/.test(String(req.params.imageId)))return res.sendStatus(400);
  try {
    const result=await pool.query(`SELECT i.storage_key FROM property_images i
      JOIN properties p ON p.id=i.property_id WHERE i.id=$1 AND p.status='APPROVED'`,[req.params.imageId]);
    if(!result.rowCount)return res.sendStatus(404);
    const key=String(result.rows[0].storage_key);
    if(!/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(key))return res.sendStatus(404);
    const file=path.resolve(process.cwd(),"uploads/properties",key);
    const buffer=await fs.readFile(file);
    res.setHeader("Content-Type",key.endsWith(".png")?"image/png":key.endsWith(".jpg")?"image/jpeg":"image/webp");
    res.setHeader("Cache-Control","public, max-age=60");
    return res.send(buffer);
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return res.sendStatus(404);console.error(e);return res.sendStatus(500);}
});
export default router;
