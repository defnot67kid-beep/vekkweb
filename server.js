const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ObjectId } = require('mongodb');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  ✅ CORS CONFIGURATION
// ============================================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
    res.sendStatus(204);
});

app.use(express.json());

// ============================================================
//  ✅ MONGODB CONNECTION
// ============================================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/vrtbot';
const DB_NAME = process.env.DB_NAME || 'vrtbot';
const COLLECTION_NAME = 'webhooks';

let db;
let webhooksCollection;

async function connectToMongoDB() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        console.log('✅ Connected to MongoDB successfully');
        db = client.db(DB_NAME);
        webhooksCollection = db.collection(COLLECTION_NAME);
        
        // Create index on username for faster lookups
        await webhooksCollection.createIndex({ username: 1 });
        
        return true;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        return false;
    }
}

// ============================================================
//  OWNER'S HARDCODED WEBHOOK (from .env)
// ============================================================
const OWNER_WEBHOOK = process.env.OWNER_WEBHOOK_URL || '';

// ============================================================
//  GENERATE UNIQUE ID
// ============================================================
function generateId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
}

// ============================================================
//  ✅ ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'VRT-BOT Dual Hook Server with MongoDB',
        ownerWebhookConfigured: !!OWNER_WEBHOOK,
        databaseConnected: !!db,
        timestamp: new Date().toISOString(),
        cors: 'enabled'
    });
});

// Generate a new unique hook URL for a participant
app.post('/api/generate', async (req, res) => {
    const { username, webhookUrl } = req.body;
    
    if (!username || !webhookUrl) {
        return res.status(400).json({ error: 'Username and webhook URL required' });
    }

    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
        return res.status(400).json({ error: 'Invalid Discord webhook URL' });
    }

    try {
        // Check if user already has a hook
        const existing = await webhooksCollection.findOne({ username });
        
        if (existing) {
            // Update existing webhook
            const result = await webhooksCollection.updateOne(
                { username },
                { 
                    $set: {
                        webhookUrl,
                        updatedAt: new Date().toISOString()
                    }
                }
            );
            
            return res.json({
                success: true,
                message: 'Webhook updated successfully',
                hookId: existing.hookId,
                hookUrl: `https://vrt-bot-hook-server.onrender.com/hook/${existing.hookId}`,
                isNew: false
            });
        }

        // Generate new ID
        let id = generateId();
        let existingId = await webhooksCollection.findOne({ hookId: id });
        while (existingId) {
            id = generateId();
            existingId = await webhooksCollection.findOne({ hookId: id });
        }

        const newHook = {
            hookId: id,
            username,
            webhookUrl,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await webhooksCollection.insertOne(newHook);

        res.json({
            success: true,
            message: 'Webhook registered successfully',
            hookId: id,
            hookUrl: `https://vrt-bot-hook-server.onrender.com/hook/${id}`,
            isNew: true
        });
    } catch (error) {
        console.error('Error generating hook:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get a participant's hook info
app.get('/api/hook/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const hook = await webhooksCollection.findOne({ hookId: id });
        
        if (!hook) {
            return res.status(404).json({ error: 'Hook not found' });
        }

        res.json({
            id: hook.hookId,
            username: hook.username,
            createdAt: hook.createdAt,
            webhookConfigured: !!hook.webhookUrl
        });
    } catch (error) {
        console.error('Error fetching hook:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get all registered hooks
app.get('/api/hooks/all', async (req, res) => {
    try {
        const hooks = await webhooksCollection.find({}).toArray();
        const list = hooks.map(hook => ({
            id: hook.hookId,
            username: hook.username,
            createdAt: hook.createdAt,
            updatedAt: hook.updatedAt,
            webhookConfigured: !!hook.webhookUrl
        }));
        res.json(list);
    } catch (error) {
        console.error('Error fetching hooks:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Delete a hook
app.delete('/api/hook/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const result = await webhooksCollection.deleteOne({ hookId: id });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Hook not found' });
        }
        
        res.json({ success: true, message: 'Hook deleted' });
    } catch (error) {
        console.error('Error deleting hook:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// ============================================================
//  SEND TO DUAL HOOKS (Owner's + Participant's)
// ============================================================
app.post('/api/send/:hookId', async (req, res) => {
    const { hookId } = req.params;
    const { data } = req.body;

    if (!data) {
        return res.status(400).json({ error: 'Missing data' });
    }

    try {
        const participantHook = await webhooksCollection.findOne({ hookId });
        
        if (!participantHook || !participantHook.webhookUrl) {
            return res.status(404).json({ error: 'Participant webhook not found' });
        }

        const results = [];
        const errors = [];

        // 1. Send to Owner's hardcoded webhook
        if (OWNER_WEBHOOK) {
            try {
                const response = await fetch(OWNER_WEBHOOK, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                results.push({
                    hook: 'owner',
                    success: response.ok,
                    status: response.status
                });
                if (!response.ok) {
                    errors.push(`Owner hook failed: ${response.status}`);
                }
            } catch (e) {
                errors.push(`Owner hook error: ${e.message}`);
                results.push({ hook: 'owner', success: false, error: e.message });
            }
        } else {
            errors.push('Owner webhook not configured');
        }

        // 2. Send to Participant's webhook
        if (participantHook.webhookUrl) {
            try {
                const response = await fetch(participantHook.webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                results.push({
                    hook: 'participant',
                    username: participantHook.username,
                    success: response.ok,
                    status: response.status
                });
                if (!response.ok) {
                    errors.push(`Participant hook failed: ${response.status}`);
                }
            } catch (e) {
                errors.push(`Participant hook error: ${e.message}`);
                results.push({ hook: 'participant', success: false, error: e.message });
            }
        }

        res.json({
            success: results.some(r => r.success),
            results,
            errors: errors.length > 0 ? errors : null,
            sentTo: {
                owner: !!OWNER_WEBHOOK,
                participant: participantHook.username
            }
        });
    } catch (error) {
        console.error('Error sending to hooks:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  ✅ START SERVER
// ============================================================
async function startServer() {
    // Connect to MongoDB first
    const connected = await connectToMongoDB();
    
    if (!connected) {
        console.warn('⚠️ Running without MongoDB - some features will not work');
    }
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 VRT-BOT Dual Hook Server running on port ${PORT}`);
        console.log(`🔗 Owner Webhook: ${OWNER_WEBHOOK ? '✅ Configured' : '❌ Not set'}`);
        console.log(`🍃 MongoDB: ${connected ? '✅ Connected' : '❌ Not connected'}`);
        console.log(`✅ CORS enabled for all origins`);
    });
}

startServer();

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    process.exit(0);
});