import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB connection
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGO_DB_NAME || 'chat_service';
if (!uri) {
  console.error('❌ MONGODB_URI is not defined');
  process.exit(1);
}
const client = new MongoClient(uri, {
  // Optionally set connection pool options here
});
let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db(dbName);
    console.log(`✅ Connected to MongoDB: ${dbName}`);
  }
  return db;
}

// Create/Join Conversation Endpoint
app.post('/api/conversations', async (req, res) => {
  const startTime = Date.now();
  // Accept supportAgentId optionally for support-initiated conversations
  const { bookingId, userId, initiatedBy = 'guest', supportAgentId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  try {
    const db = await connectDB();
    const conversationsCollection = db.collection('conversations');
    // Determine supportId: if initiated by support and supportAgentId is provided, use it; otherwise, fallback.
    const supportId =
      initiatedBy === 'support' && supportAgentId
        ? supportAgentId
        : process.env.SUPPORT_USER_ID || 'defaultSupport';

    let conversationId;
    if (initiatedBy === 'guest' && bookingId) {
      const normalizedBookingId = bookingId.replace(/\//g, '_');
      conversationId = `${normalizedBookingId}-${userId}-${supportId}`;
    } else {
      conversationId = `conversation-${userId}-${supportId}`;
    }

    let conversation = await conversationsCollection.findOne({ _id: conversationId });
    if (!conversation) {
      conversation = {
        _id: conversationId,
        participants: [userId, supportId],
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await conversationsCollection.insertOne(conversation);
      console.log('✅ New conversation created:', conversation);
    } else {
      console.log('ℹ️ Conversation already exists:', conversationId);
    }
    console.log(`Processed createSupportConversation in ${Date.now() - startTime} ms`);
    return res.json({ conversationId });
  } catch (error) {
    console.error('Error creating conversation:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get Conversations for a User
app.get('/api/conversations', async (req, res) => {
  const startTime = Date.now();
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId query parameter' });
  }
  try {
    const db = await connectDB();
    const conversationsCollection = db.collection('conversations');
    // Use projection to limit data returned (adjust fields as needed)
    const conversations = await conversationsCollection
      .find({ participants: userId }, { projection: { _id: 1, participants: 1, messages: 1 } })
      .toArray();
    console.log(`Fetched ${conversations.length} conversation(s) for user ${userId} in ${Date.now() - startTime} ms`);
    return res.json({ conversations });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Socket.IO Setup
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('joinConversation', (conversationId) => {
    socket.join(conversationId);
    console.log(`Socket ${socket.id} joined conversation ${conversationId}`);
  });

  socket.on('sendMessage', async (data, callback) => {
    const { conversationId, senderId, content, timestamp } = data;
    const message = {
      messageId: new ObjectId().toHexString(),
      senderId,
      content,
      timestamp,
      read: false,
      status: 'sent',
    };

    try {
      const db = await connectDB();
      const conversationsCollection = db.collection('conversations');
      await conversationsCollection.updateOne(
        { _id: conversationId },
        { $push: { messages: message }, $set: { updatedAt: new Date().toISOString() } }
      );
      io.to(conversationId).emit('receiveMessage', message);
      callback({ success: true });
    } catch (error) {
      console.error('Error saving message:', error);
      callback({ success: false });
    }
  });

  socket.on('markAsRead', async ({ conversationId, messageId }) => {
    console.log(`Received markAsRead for conversation ${conversationId}, message ${messageId}`);
    try {
      const db = await connectDB();
      const conversationsCollection = db.collection('conversations');
      const result = await conversationsCollection.updateOne(
        { _id: conversationId, 'messages.messageId': messageId },
        { $set: { 'messages.$.read': true, updatedAt: new Date().toISOString() } }
      );
      console.log('Update result:', result);
      io.to(conversationId).emit('messageRead', { messageId });
    } catch (error) {
      console.error('Error marking message as read:', error);
    }
  });
});

// Get Conversation by ID Endpoint
app.get('/api/conversation/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  if (!conversationId) {
    return res.status(400).json({ error: 'Missing conversationId' });
  }
  try {
    const db = await connectDB();
    const conversationsCollection = db.collection('conversations');
    const conversation = await conversationsCollection.findOne({ _id: conversationId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    return res.json(conversation);
  } catch (error) {
    console.error('Error fetching conversation:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Send System Message Endpoint
app.post('/api/sendSystemMessage', async (req, res) => {
  const { conversationId, content } = req.body;
  if (!conversationId || !content) {
    return res.status(400).json({ error: "Missing conversationId or content" });
  }
  try {
    const db = await connectDB();
    const conversationsCollection = db.collection('conversations');
    // Create a system message object.
    const systemMessage = {
      messageId: new ObjectId().toHexString(),
      senderId: "system",  // Indicates a system message.
      content,             // This should include moderationComments if desired.
      timestamp: new Date().toISOString(),
      read: false,
      status: "sent",
      system: true         // A flag to denote that this is a system message.
    };
    // Push the system message into the messages array of the conversation.
    const result = await conversationsCollection.updateOne(
      { _id: conversationId },
      { $push: { messages: systemMessage }, $set: { updatedAt: new Date().toISOString() } }
    );
    if (result.modifiedCount === 1) {
      // Emit the message to any connected clients in that conversation room.
      io.to(conversationId).emit("receiveMessage", systemMessage);
      return res.json({ success: true, message: systemMessage });
    } else {
      return res.status(404).json({ error: "Conversation not found or message not added" });
    }
  } catch (error) {
    console.error("Error in /api/sendSystemMessage:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


// Start the server on the assigned PORT
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`✅ Chat backend running on port ${PORT}`);
});
