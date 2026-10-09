import { Router } from 'express';
import { previewAdminDeletion, executeAdminDeletion } from '../services/adminDeletion.js';

// Mounted only beneath requireAuth + requireSuperadmin. Preview never mutates
// business records; execute accepts the actor-bound snapshot, never raw IDs.
const router = Router();
router.post('/preview', async (req, res, next) => {
  try { res.json(await previewAdminDeletion(req.body, req.user)); } catch (error) { next(error); }
});
router.post('/execute', async (req, res, next) => {
  try {
    const result = await executeAdminDeletion(req.body, req.user);
    req.auditDetails = { operation: 'soft-delete', resource: result.resource, deletedCount: result.deletedCount, protectedCount: result.protectedCount };
    res.json(result);
  } catch (error) { next(error); }
});
export default router;
