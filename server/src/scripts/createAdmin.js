import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/db.js';
import User from '../models/User.js';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const email = value('--email')?.trim().toLowerCase();
const password = value('--password');
const name = value('--name')?.trim();
const company = value('--company')?.trim() || 'Acme Commerce';

if (!email || !password || !name || password.length < 8) {
  console.error('Usage: npm run create-admin -- --email you@example.com --password YourPassword --name "Your Name" [--company "Company"]');
  process.exit(1);
}

try {
  await connectDatabase();
  if (await User.exists({ email })) throw new Error('A user with this email already exists.');
  const user = await User.create({ name, email, password, company, role: 'owner' });
  console.log(`Created owner account for ${user.email}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
