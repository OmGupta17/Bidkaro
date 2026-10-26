import { pool } from "../db";

export async function getAdminPropertyDetail(propertyId: string) {
  if (!/^[1-9]\d*$/.test(propertyId)) {
    return null;
  }

  const result = await pool.query(
    `SELECT
       p.id,
       p.title,
       p.property_type,
       p.listing_type,
       p.description,
       p.price,
       p.area_sqft,
       p.bedrooms,
       p.bathrooms,
       p.address,
       p.city,
       p.state,
       p.pincode,
       p.status,
       p.rejection_reason,
       p.created_at,
       p.updated_at,
       p.reviewed_at,
       u.id AS seller_id,
       u.full_name AS seller_name,
       u.email AS seller_email,
       u.phone AS seller_phone,
       u.kyc_status AS seller_kyc_status,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'id', i.id,
               'mime_type', i.mime_type,
               'sort_order', i.sort_order
             )
             ORDER BY i.sort_order
           )
           FROM property_images i
           WHERE i.property_id = p.id
         ),
         '[]'::json
       ) AS images
     FROM properties p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.id = $1`,
    [propertyId]
  );

  return result.rows[0] ?? null;
}
