import dotenv from 'dotenv';
import { MongoClient, ServerApiVersion } from 'mongodb';

// Load environment variables
dotenv.config({ path: '../.env' });

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGO_DB_NAME || 'spanish_holiday_rentals';

if (!uri) {
  console.error('❌ MONGO_URI is not defined in the environment');
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let databaseInstance = null;

async function connectDB() {
  if (!databaseInstance) {
    try {
      await client.connect();
      databaseInstance = client.db(dbName); // ✅ Correctly get database instance
      console.log(`✅ Connected to MongoDB: ${dbName}`);
    } catch (err) {
      console.error('❌ Failed to connect to MongoDB:', err);
      process.exit(1);
    }
  }
  return databaseInstance;
}

export { client, connectDB };
