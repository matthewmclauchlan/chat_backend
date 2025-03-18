import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { ObjectId } from 'mongodb';
import { connectDB } from './db.js';
import * as sdk from 'node-appwrite';

// Setup App and Middleware
const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
let db;
connectDB()
  .then((database) => {
    db = database;
    console.log('✅ Connected to MongoDB!');
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Appwrite Client Setup
const client = new sdk.Client();
client
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_SECRET_API_KEY);

const databases = new sdk.Databases(client);

// Health check endpoint
app.get('/', (req, res) => res.send('Chat Backend is running!'));

// Fetch Booking Details from Appwrite by `bookingId`
app.get('/api/bookings/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  try {
    console.log(`🔍 Fetching booking from Appwrite for ID: ${bookingId}`);
    const response = await databases.getDocument(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_BOOKINGS_COLLECTION_ID,
      bookingId
    );
    if (!response) {
      console.log(`❌ No booking found for ID: ${bookingId}`);
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json({
      bookingId: response.$id,
      propertyId: response.propertyId || "N/A",
      checkInDate: response.startDate || "N/A",
      checkOutDate: response.endDate || "N/A",
      paymentStatus: response.paymentId ? "Paid" : "Unpaid",
      status: response.status || "N/A",
      totalAmount: response.appliedPriceRuleIds?.length > 0 ? calculateTotal(response.appliedPriceRuleIds) : undefined,
      currency: "€",
    });
  } catch (error) {
    console.error("❌ Error fetching booking:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Support Conversation API
app.post('/api/createSupportConversation', async (req, res) => {
  const { bookingId, userId } = req.body;
  if (!bookingId || !userId) {
    console.log('❌ Missing bookingId or userId:', { bookingId, userId });
    return res.status(400).json({ error: 'bookingId and userId are required' });
  }
  try {
    console.log('✅ Creating support conversation for booking:', bookingId);
    const conversationsCollection = db.collection('conversations');
    const supportUserId = process.env.SUPPORT_USER_ID || '67d2eb99001ca2b957ce';
    const conversationId = `${bookingId}-${userId}-${supportUserId}-support`;
    let conversation = await conversationsCollection.findOne({ _id: conversationId });
    if (!conversation) {
      conversation = {
        _id: conversationId,
        participants: [userId, supportUserId],
        messages: [],
        bookingId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await conversationsCollection.insertOne(conversation);
    }
    console.log('✅ Created support conversation:', conversation);
    res.json({ conversationId });
  } catch (error) {
    console.error('❌ Error creating support conversation:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Fetch Conversation and Booking Details Together
app.get('/api/bookings/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const bookingId = conversationId.split('-')[0];
  console.log(`🔍 Extracted bookingId for Appwrite: ${bookingId}`);
  try {
    const booking = await databases.getDocument(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_BOOKINGS_COLLECTION_ID,
      bookingId
    );
    res.json({ booking });
  } catch (error) {
    console.error('❌ Appwrite error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Socket.IO Setup
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinConversation', (conversationId) => {
    socket.join(conversationId);
    console.log(`Socket ${socket.id} joined conversation ${conversationId}`);
    const roomMembers = io.sockets.adapter.rooms.get(conversationId);
    console.log(`Room ${conversationId} current members:`, roomMembers);
  });

  socket.on('sendMessage', async (data, callback) => {
    const { conversationId, senderId, content, timestamp, bookingId, senderAvatarUrl } = data;
    console.log(`Received sendMessage from ${senderId} for conversation ${conversationId}`);
    
    const message = {
      messageId: new ObjectId().toHexString(),
      senderId,
      content,
      timestamp,
      read: false,
      status: 'sent',
      bookingId,
      senderAvatarUrl,
    };
    
    try {
      const conversationsCollection = db.collection('conversations');
      let conversation = await conversationsCollection.findOne({ _id: conversationId });
      if (!conversation) {
        console.log(`Conversation ${conversationId} not found. Creating a new one.`);
        await conversationsCollection.insertOne({
          _id: conversationId,
          participants: [senderId, process.env.SUPPORT_USER_ID || '67d2eb99001ca2b957ce'],
          messages: [],
          bookingId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      await conversationsCollection.updateOne(
        { _id: conversationId },
        { $push: { messages: message }, $set: { updatedAt: new Date().toISOString() } }
      );
      
      io.to(conversationId).emit('receiveMessage', message);
      callback({ success: true });
    } catch (error) {
      console.error('❌ Error saving message:', error);
      callback({ success: false });
    }
  });
  
  socket.on('markAsRead', async ({ conversationId, messageId }) => {
    try {
      const conversationsCollection = db.collection('conversations');
      await conversationsCollection.updateOne(
        { _id: conversationId, 'messages.messageId': messageId },
        { $set: { 'messages.$.read': true, updatedAt: new Date().toISOString() } }
      );
      io.to(conversationId).emit('messageRead', { messageId });
    } catch (error) {
      console.error('❌ Error marking message as read:', error);
    }
  });

  // Add this endpoint in your server.js after your Socket.IO setup, before server.listen

app.post('/api/sendSystemMessage', async (req, res) => {
  try {
    // Extract conversationId and content from the request body.
    const { conversationId, content } = req.body;
    if (!conversationId || !content) {
      return res.status(400).json({ error: "Missing conversationId or content" });
    }

    // Create a system message object.
    const systemMessage = {
      messageId: new ObjectId().toHexString(),
      senderId: "system",  // Use "system" (or a reserved ID) for system messages.
      content,
      timestamp: new Date().toISOString(),
      read: false,
      status: "sent",
      system: true  // Custom flag to indicate this is a system message.
    };

    // Update the conversation document in MongoDB.
    const conversationsCollection = db.collection('conversations');
    await conversationsCollection.updateOne(
      { _id: conversationId },
      { $push: { messages: systemMessage }, $set: { updatedAt: new Date().toISOString() } }
    );

    // Emit the system message via Socket.IO to all clients in the conversation.
    io.to(conversationId).emit("receiveMessage", systemMessage);

    return res.json({ success: true, message: systemMessage });
  } catch (err) {
    console.error("Error in /api/sendSystemMessage:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

});

server.listen(4000, () => {
  console.log('✅ Backend running on port 4000');
});
