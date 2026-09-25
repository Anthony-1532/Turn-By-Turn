import mongoose from 'mongoose';
import { config } from './config/env';

mongoose.set('strictQuery', true);

export { mongoose };

export async function connect(uri: string = config.mongoUri): Promise<mongoose.Connection> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  // Build indexes (History filters, uniqueness guarantees, TTLs) on boot.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  return mongoose.connection;
}

export async function disconnect(): Promise<void> {
  await mongoose.disconnect();
}

/** Drops the whole database. Used by the seed script and tests only. */
export async function dropDatabase(): Promise<void> {
  if (!mongoose.connection.db) throw new Error('Database not connected');
  await mongoose.connection.db.dropDatabase();
}
