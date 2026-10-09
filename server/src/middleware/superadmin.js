import { AdminAudit } from '../models/Platform.js';

export function requireSuperadmin(req, res, next) {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ message: 'Superadmin access is required.' });
  next();
}
export function auditAdminChanges(req, res, next) {
  res.on('finish', () => {
    if (req.user?.role !== 'superadmin' || (['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.auditRead) || res.statusCode >= 400) return;
    AdminAudit.create({ actor: req.user._id, action: `${req.method} ${req.path}`, workspace: req.workspace?._id, target: req.path, details: { statusCode: res.statusCode, fields: Object.keys(req.body || {}).filter(key => !/password|token|secret/i.test(key)), ...req.auditDetails } }).catch(error => console.error('Unable to write superadmin audit event:', error.message));
  });
  next();
}
