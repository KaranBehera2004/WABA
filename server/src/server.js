import 'dotenv/config';
import app from './app.js';
import { connectDatabase } from './config/db.js';
import { initializeTestWallets } from './services/wallet.js';

const port = Number(process.env.PORT) || 5000;

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to a secure value of at least 32 characters.');
  process.exit(1);
}

connectDatabase()
  .then(async () => { const count = await initializeTestWallets(); console.log(`Test wallets ready for ${count} workspaces. No real funds are used.`); })
  .then(() => app.listen(port, () => console.log(`WABA API listening on http://localhost:${port}`)))
  .catch(error => {
    console.error('Failed to start API:', error.message);
    process.exit(1);
  });
