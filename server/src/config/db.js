import mongoose from 'mongoose';

export async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing. Add your MongoDB Atlas connection string to server/.env.');
  }
  mongoose.connection.on('error', error => console.error('MongoDB error:', error.message));
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'waba',
    serverSelectionTimeoutMS: 10000,
  });
  console.log(`MongoDB Atlas connected: ${mongoose.connection.name}`);
}
