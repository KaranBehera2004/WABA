import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/db.js';
import User from '../models/User.js';
import { AdminAudit } from '../models/Platform.js';

const args = process.argv.slice(2);
const argument = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const email = argument('--email')?.trim().toLowerCase();
if (!email) { console.error('Usage: npm run create-superadmin -- --email existing-user@example.com'); process.exit(1); }
try {
  await connectDatabase();
  const user = await User.findOne({ email });
  if (user?.deletedAt) throw new Error('This account has been deleted. Archived accounts cannot be promoted.');
  if (!user) throw new Error('Register this email in WABA first, then run this command.');
  if (!user.isActive) throw new Error('This account is inactive. Reactivate it before granting access.');
  user.role = 'superadmin'; user.sessionVersion = (user.sessionVersion || 0) + 1; await user.save();
  await AdminAudit.create({ actor: user._id, action: 'BOOTSTRAP superadmin', target: String(user._id), details: { source: 'Local administrator command' } });
  console.log('Superadmin access granted. Sign out and sign in again with this account.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
