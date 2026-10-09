import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/db.js';
import { initializeTestWallets } from '../services/wallet.js';

try {
  await connectDatabase();
  const processed = await initializeTestWallets();
  console.log(`Initialized missing test wallets for ${processed} businesses. Existing balances preserved. No real money was added.`);
} catch (error) { console.error('Unable to initialize test wallets:', error.message); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
