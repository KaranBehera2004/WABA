import { Router } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { createWorkspaceForUser, ensureUserWorkspace } from '../services/workspace.js';
import { platformSettings } from '../services/platform.js';
import { passwordPolicyError, sessionExpiry, signupAllowed } from '../services/platformConfig.js';
import { randomUUID } from 'node:crypto';
import { AuthSession } from '../models/Business.js';

const router = Router();
router.use((req, _res, next) => { req.body ||= {}; next(); });
router.get('/platform', async (_req, res, next) => {
  try {
    const settings = await platformSettings();
    const publicKeys = ['platformName', 'supportEmail', 'supportPhone', 'supportUrl', 'termsUrl', 'privacyUrl', 'loginTitle', 'loginDescription', 'footerText', 'passwordMinLength', 'passwordRequireUppercase', 'passwordRequireNumber', 'trialDays', 'memberAccessEnabled'];
    res.json({ ...Object.fromEntries(publicKeys.map(key => [key, settings[key]])), registrationEnabled: settings.registrationEnabled && !settings.maintenanceEnabled && settings.memberAccessEnabled && settings.workspaceLimitPerOwner !== 0, maintenanceEnabled: settings.maintenanceEnabled, maintenanceMessage: settings.maintenanceEnabled ? settings.maintenanceMessage : '', signupRestricted: Boolean(settings.allowedSignupDomains.length) });
  }
  catch (error) { next(error); }
});

router.post('/register', async (req, res, next) => {
  try {
    const settings = await platformSettings();
    if (!settings.registrationEnabled || settings.maintenanceEnabled || !settings.memberAccessEnabled || settings.workspaceLimitPerOwner === 0) return res.status(403).json({ message: 'New registration is temporarily disabled. Contact the platform administrator.' });
    const name = String(req.body.name || '').trim();
    const company = String(req.body.company || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name || !company || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Name, company and a valid email are required.' });
    if (!signupAllowed(email, settings)) return res.status(403).json({ message: 'Registration is restricted to approved email domains. Contact the platform administrator.' });
    const passwordError = passwordPolicyError(password, settings); if (passwordError) return res.status(400).json({ message: passwordError });
    if (await User.exists({ email })) return res.status(409).json({ message: 'An account with this email already exists.' });
    const session = await mongoose.startSession(); let user;
    try {
      await session.withTransaction(async () => {
        [user] = await User.create([{ name, company, email, password, role: 'owner' }], { session });
        await createWorkspaceForUser(user, company, { session, settings });
      });
    } finally { await session.endSession(); }
    const token = jwt.sign({ sub: user._id.toString(), role: user.role, version: user.sessionVersion || 0 }, process.env.JWT_SECRET, { expiresIn: sessionExpiry(settings), issuer: 'waba-api' });
    res.status(201).json({ token, user: user.toSafeObject() });
  } catch (error) { next(error); }
});

router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

    const user = await User.findOne({ email }).select('+password');
    if (!user || !user.isActive || user.deletedAt || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'The email or password is incorrect.' });
    }
    const settings = await platformSettings();
    if (user.role !== 'superadmin' && settings.memberAccessEnabled === false) return res.status(503).json({ message: 'Workspace sign-in has been paused by the platform administrator.' });

    await ensureUserWorkspace(user);

    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });
    const sid = randomUUID();
    const token = jwt.sign({ sub: user._id.toString(), role: user.role, version: user.sessionVersion || 0, sid }, process.env.JWT_SECRET, {
      expiresIn: sessionExpiry(settings),
      issuer: 'waba-api',
    });
    const decoded = jwt.decode(token);
    await AuthSession.create({ user: user._id, key: sid, label: String(req.headers['user-agent'] || 'Browser').slice(0,200), expiresAt: new Date(decoded.exp * 1000) });
    res.json({ token, user: user.toSafeObject() });
  } catch (error) { next(error); }
});

router.get('/me', requireAuth, async (req, res, next) => { try { await ensureUserWorkspace(req.user); res.json({ user: req.user.toSafeObject() }); } catch (error) { next(error); } });
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    for (const key of ['name', 'company']) {
      if (req.body[key] !== undefined) {
        if (typeof req.body[key] !== 'string' || !req.body[key].trim()) return res.status(400).json({ message: 'Name and business name cannot be empty.' });
        req.user[key] = req.body[key].trim();
      }
    }
    await req.user.save();
    res.json({ user: req.user.toSafeObject() });
  } catch (error) { next(error); }
});

export default router;
