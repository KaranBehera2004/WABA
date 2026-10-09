import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { AuthSession } from '../models/Business.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Authentication required.' });

    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'waba-api' });
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive || user.deletedAt) return res.status(401).json({ code: 'ACCOUNT_UNAVAILABLE', message: 'Account is unavailable.' });
    if ((payload.version || 0) !== (user.sessionVersion || 0)) return res.status(401).json({ code: 'SESSION_REVOKED', message: 'Your account credentials changed. Please sign in again.' });
    if (payload.sid && !await AuthSession.exists({ key: payload.sid, user: user._id, revokedAt: null, expiresAt: { $gt: new Date() } })) return res.status(401).json({ code: 'SESSION_REVOKED', message: 'This session was revoked. Please sign in again.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ code: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' });
  }
}
