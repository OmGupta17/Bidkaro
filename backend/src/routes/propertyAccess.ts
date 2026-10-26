import {Router} from "express";
import {pool} from "../db";
import {requireUser,type UserRequest} from "../middleware/requireUser";
const router=Router();
router.use(requireUser);
router.get("/subscription",async(req:UserRequest,res)=>{
 try{const result=await pool.query(`SELECT MAX(expires_at) AS expires_at FROM subscriptions WHERE user_id=$1 AND expires_at>NOW()`,[req.authenticatedUser!.id]);
 res.json({active:!!result.rows[0]?.expires_at,expires_at:result.rows[0]?.expires_at||null});}
 catch{res.status(500).json({message:"Unable to check subscription"});}
});
router.get("/properties/:id",async(req:UserRequest,res)=>{
 if(!/^[1-9]\d*$/.test(String(req.params.id)))return res.sendStatus(400);
 try{
 const result=await pool.query(`SELECT p.id,p.title,p.description,p.address,p.owner_name,p.owner_phone,
 (EXISTS(SELECT 1 FROM property_unlocks u WHERE u.user_id=$1 AND u.property_id=p.id)
 OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=$1 AND s.expires_at>NOW())) AS has_access
 FROM properties p WHERE p.id=$2 AND p.status='APPROVED'`,[req.authenticatedUser!.id,req.params.id]);
 if(!result.rowCount)return res.sendStatus(404);
 if(!result.rows[0].has_access)return res.status(403).json({has_access:false,message:"Purchase required"});
 const {has_access,...details}=result.rows[0];return res.json({has_access:true,property:details});
 }catch(e){console.error(e);return res.status(500).json({message:"Unable to load protected details"});}
});
export default router;
