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
            await queueCollection.createIndex({ createdAt: 1 });
            await queueCollection.createIndex({ hookId: 1 });
            await queueCollection.createIndex({ retryAfter: 1 });
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
//  ✅ QUEUE SYSTEM FOR OWNER WEBHOOK
// ============================================================
async function addToOwnerQueue(hookId, data, participantWebhook, username) {
    const queueItem = {
        hookId,
        username,
        data,
        participantWebhook,
        status: 'pending', // pending, sending, sent, failed
        attempts: 0,
        maxAttempts: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
        retryAfter: null
    };
    
    const result = await queueCollection.insertOne(queueItem);
    console.log(`📥 Added to owner queue: ${result.insertedId}`);
    return result.insertedId;
}

async function getPendingOwnerQueueItems(limit = 5) {
    return await queueCollection
        .find({ 
            status: 'pending',
            $or: [
                { retryAfter: { $exists: false } },
                { retryAfter: { $lt: new Date().toISOString() } }
            ]
        })
        .sort({ createdAt: 1 })
        .limit(limit)
        .toArray();
}

async function updateQueueItem(id, updates) {
    return await queueCollection.updateOne(
        { _id: id },
        { $set: { ...updates, updatedAt: new Date().toISOString() } }
    );
}

async function getQueueStats() {
    const pending = await queueCollection.countDocuments({ status: 'pending' });
    const sending = await queueCollection.countDocuments({ status: 'sending' });
    const sent = await queueCollection.countDocuments({ status: 'sent' });
    const failed = await queueCollection.countDocuments({ status: 'failed' });
    
    return { pending, sending, sent, failed, total: pending + sending + sent + failed };
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
//  ✅ BACKGROUND PROCESSOR FOR OWNER WEBHOOK
// ============================================================
let isProcessing = false;

async function processOwnerQueue() {
    if (isProcessing) return;
    isProcessing = true;
    
    console.log('🔄 Processing owner queue...');
    
    try {
        const items = await getPendingOwnerQueueItems(3);
        
        if (items.length === 0) {
            isProcessing = false;
            return;
        }
        
        console.log(`📤 Processing ${items.length} queue items for owner webhook`);
        
        for (const item of items) {
            // Mark as sending
            await updateQueueItem(item._id, { status: 'sending' });
            
            console.log(`📤 Sending to owner webhook for user: ${item.username}`);
            
            // Send to owner webhook
            const result = await sendToWebhook(OWNER_WEBHOOK, item.data);
            
            if (result.success) {
                await updateQueueItem(item._id, {
                    status: 'sent',
                    completedAt: new Date().toISOString(),
                    lastError: null
                });
                console.log(`✅ Owner webhook sent successfully for ${item.username}`);
            } else if (result.status === 429) {
                // Rate limited - set retry time
                const retryAfter = parseInt(result.retryAfter) || 30;
                const retryTime = new Date(Date.now() + (retryAfter * 1000)).toISOString();
                await updateQueueItem(item._id, {
                    status: 'pending',
                    retryAfter: retryTime,
                    attempts: item.attempts + 1,
                    lastError: `Rate limited, retry after ${retryAfter}s`
                });
                console.log(`⏳ Owner rate limited, retry at ${retryTime}`);
            } else {
                // Other error
                if (item.attempts >= item.maxAttempts) {
                    await updateQueueItem(item._id, {
                        status: 'failed',
                        lastError: result.error || 'Max attempts reached'
                    });
                    console.log(`❌ Owner webhook failed after ${item.attempts} attempts`);
                } else {
                    await updateQueueItem(item._id, {
                        status: 'pending',
                        attempts: item.attempts + 1,
                        lastError: result.error || 'Retrying'
                    });
                    console.log(`⚠️ Owner webhook failed, retrying (${item.attempts + 1}/${item.maxAttempts})`);
                }
            }
            
            // Wait between items
            await new Promise(r => setTimeout(r, 250));
        }
        
    } catch (error) {
        console.error('❌ Owner queue processing error:', error);
    } finally {
        isProcessing = false;
        
        // Check for more items
        const pending = await queueCollection.countDocuments({ status: 'pending' });
        if (pending > 0) {
            console.log(`🔄 ${pending} items still pending in owner queue, continuing...`);
            setTimeout(processOwnerQueue, 5000);
        }
    }
}

async function sendToWebhook(webhookUrl, data) {
    try {
        console.log(`📤 Sending to webhook: ${webhookUrl.substring(0, 50)}...`);
        
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const responseText = await response.text();

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
    setInterval(() => {
        processOwnerQueue();
    }, 10000); // Check every 10 seconds
}

// ============================================================
//  ✅ API ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'VRT-BOT Dual Hook Server - Participant Priority',
        ownerWebhookConfigured: !!OWNER_WEBHOOK,
        databaseConnected: !!db,
        queueStats: 'Use /api/queue/stats',
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

// Generate a new unique hook URL for a participant
app.post('/api/generate', async (req, res) => {
    const { username, webhookUrl } = req.body;
    
    console.log(`🔑 Generating hook for user: ${username}`);
    console.log(`🔗 Webhook URL: ${webhookUrl.substring(0, 60)}...`);
    
    if (!username || !webhookUrl) {
        return res.status(400).json({ error: 'Username and webhook URL required' });
    }

    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
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
            
            console.log(`✅ Webhook updated for user: ${username}`);
            
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
//  ✅ SEND TO PARTICIPANT FIRST + QUEUE FOR OWNER
// ============================================================
app.post('/api/send/:hookId', async (req, res) => {
    const { hookId } = req.params;
    const { data } = req.body;

    console.log(`📨 Received send request for hook: ${hookId}`);
    console.log(`📦 Data:`, JSON.stringify(data).substring(0, 300));

    if (!data) {
        console.log('❌ No data provided');
        return res.status(400).json({ error: 'Missing data' });
    }

    if (!db || !webhooksCollection) {
        console.log('❌ Database not connected');
        return res.status(503).json({ error: 'Database not connected' });
    }

    try {
        // Get the hook
        const hook = await webhooksCollection.findOne({ hookId });
        if (!hook) {
            console.log(`❌ Hook not found: ${hookId}`);
            return res.status(404).json({ error: 'Hook not found' });
        }

        const results = [];
        let participantSuccess = false;
        let participantError = null;

        // ============================================================
        //  1. ALWAYS SEND TO PARTICIPANT FIRST (Priority)
        // ============================================================
        console.log(`👤 Sending to participant: ${hook.username}`);
        console.log(`🔗 Participant webhook: ${hook.webhookUrl.substring(0, 60)}...`);
        
        if (hook.webhookUrl) {
            const participantResult = await sendToWebhook(hook.webhookUrl, data);
            
            if (participantResult.success) {
                participantSuccess = true;
                results.push({
                    target: 'participant',
                    username: hook.username,
                    success: true,
                    status: participantResult.status
                });
                console.log(`✅ Participant webhook sent successfully: ${hook.username}`);
            } else {
                participantError = participantResult.error || participantResult.status;
                results.push({
                    target: 'participant',
                    username: hook.username,
                    success: false,
                    status: participantResult.status,
                    error: participantResult.error
                });
                console.log(`⚠️ Participant webhook failed: ${participantResult.error}`);
            }
        }

        // ============================================================
        //  2. QUEUE FOR OWNER WEBHOOK (Background processing)
        // ============================================================
        if (OWNER_WEBHOOK) {
            console.log(`📥 Queuing for owner webhook (user: ${hook.username})`);
            
            const queueId = await addToOwnerQueue(
                hookId,
                data,
                hook.webhookUrl,
                hook.username
            );
            
            results.push({
                target: 'owner',
                status: 'queued',
                queueId: queueId
            });
            
            console.log(`✅ Added to owner queue: ${queueId}`);
            
            // Trigger processing if not already running
            processOwnerQueue();
        }

        // ============================================================
        //  3. RETURN RESPONSE
        // ============================================================
        res.json({
            success: participantSuccess,
            message: participantSuccess 
                ? 'Participant notified successfully, owner webhook queued' 
                : 'Participant failed, but queued for retry',
            hookId: hookId,
            username: hook.username,
            participant: {
                success: participantSuccess,
                error: participantError
            },
            owner: {
                queued: !!OWNER_WEBHOOK,
                queueId: results.find(r => r.target === 'owner')?.queueId || null
            },
            results: results,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Error processing request:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
    }
});

// ============================================================
//  ✅ SERVE HOOK PAGE (HTML)
// ============================================================
app.get('/hook/:id', async (req, res) => {
    const { id } = req.params;
    
    console.log(`📄 Serving hook page: ${id}`);
    
    if (!db || !webhooksCollection) {
        return res.status(503).send(`
            <!DOCTYPE html>
            <html><head><title>Database Error</title></head>
            <body style="font-family:sans-serif;background:#0e0f11;color:#fff;display:grid;place-items:center;height:100vh;margin:0;">
                <div style="text-align:center;">
                    <h1>⚠️ Database Error</h1>
                    <p style="color:#969aa5;">The database is not connected. Please try again later.</p>
                </div>
            </body></html>
        `);
    }

    try {
        const hook = await webhooksCollection.findOne({ hookId: id });
        
        if (!hook) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html><head><title>Hook Not Found</title></head>
                <body style="font-family:sans-serif;background:#0e0f11;color:#fff;display:grid;place-items:center;height:100vh;margin:0;">
                    <div style="text-align:center;">
                        <h1>🔗 Hook Not Found</h1>
                        <p style="color:#969aa5;">This hook ID does not exist or has been removed.</p>
                        <a href="/" style="color:#5271ff;">Return to VRT-BOT</a>
                    </div>
                </body></html>
            `);
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>${hook.username}'s Hook · VRT-BOT</title>
                <style>
                    *{box-sizing:border-box;margin:0;padding:0}
                    body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#0e0f11;color:#f3f3f4;min-height:100vh;display:grid;place-items:center;padding:20px;}
                    .container{width:min(600px,100%);background:rgba(34,35,40,.62);border:1px solid rgba(255,255,255,.09);border-radius:24px;padding:40px;backdrop-filter:blur(20px);box-shadow:0 25px 80px rgba(0,0,0,.4);text-align:center;}
                    h1{font-size:24px;font-weight:600;margin-bottom:6px;}
                    .username{color:#45dc93;font-weight:600;}
                    .status{display:inline-block;padding:4px 12px;border-radius:999px;font-size:10px;font-weight:600;text-transform:uppercase;background:rgba(69,220,147,.15);color:#45dc93;border:1px solid rgba(69,220,147,.2);margin-top:8px;}
                    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0;}
                    .card{padding:16px;border-radius:12px;background:rgba(0,0,0,.12);border:1px solid rgba(255,255,255,.05);text-align:center;}
                    .card .label{font-size:10px;color:#969aa5;text-transform:uppercase;}
                    .card .value{font-size:16px;font-weight:600;margin-top:4px;}
                    .actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:20px 0;}
                    .actions button{padding:12px 24px;border:0;border-radius:12px;cursor:pointer;font-weight:600;font-size:13px;transition:.2s;}
                    .primary{background:linear-gradient(135deg,#5271ff,#354ee8);color:#fff;}
                    .primary:hover{transform:scale(1.03);box-shadow:0 8px 25px rgba(82,113,255,.3);}
                    .secondary{background:rgba(255,255,255,.06);color:#969aa5;border:1px solid rgba(255,255,255,.08);}
                    .secondary:hover{background:rgba(255,255,255,.12);color:#fff;}
                    .danger{background:rgba(255,107,107,.15);color:#ff6b6b;border:1px solid rgba(255,107,107,.2);}
                    .danger:hover{background:rgba(255,107,107,.25);}
                    .footer-text{font-size:11px;color:#555;margin-top:16px;}
                    .footer-text a{color:#5271ff;text-decoration:none;}
                    .copy-success{color:#45dc93;font-size:12px;margin-top:8px;display:none;}
                    .copy-success.show{display:block;}
                    .queue-status{font-size:12px;color:#969aa5;margin-top:12px;padding:10px;background:rgba(0,0,0,.15);border-radius:8px;}
                    .queue-status .pending{color:#ffd700;}
                    .queue-status .sent{color:#45dc93;}
                    .queue-status .failed{color:#ff6b6b;}
                    .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:10px;font-weight:600;margin-left:6px;}
                    .badge.participant{background:rgba(69,220,147,.15);color:#45dc93;border:1px solid rgba(69,220,147,.2);}
                    .badge.owner{background:rgba(82,113,255,.15);color:#5271ff;border:1px solid rgba(82,113,255,.2);}
                    @media(max-width:600px){.info-grid{grid-template-columns:1fr;}}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🔗 <span class="username">${hook.username}</span>'s Hook</h1>
                    <div class="status">✅ Active</div>
                    <div style="margin-top:6px;">
                        <span class="badge participant">⚡ Participant Priority</span>
                        <span class="badge owner">📦 Owner Queued</span>
                    </div>
                    
                    <div class="info-grid">
                        <div class="card">
                            <div class="label">🔗 Hook ID</div>
                            <div class="value">${hook.hookId}</div>
                        </div>
                        <div class="card">
                            <div class="label">📅 Created</div>
                            <div class="value">${new Date(hook.createdAt).toLocaleDateString()}</div>
                        </div>
                    </div>
                    
                    <div class="actions">
                        <button class="primary" onclick="testHook()">🧪 Send Test</button>
                        <button class="secondary" onclick="checkQueue()">📊 Check Queue</button>
                        <button class="secondary" onclick="copyHookUrl()">📋 Copy URL</button>
                        <button class="danger" onclick="deleteHook()">🗑️ Delete Hook</button>
                    </div>
                    
                    <div class="queue-status" id="queueStatus">
                        <span>📊 Owner Queue: <span id="queueStats">Loading...</span></span>
                    </div>
                    
                    <div class="copy-success" id="copySuccess">✅ URL copied to clipboard!</div>
                    
                    <p style="color:#969aa5;font-size:12px;margin-top:16px;line-height:1.6;">
                        ⚡ <strong>Participant receives notifications instantly</strong><br>
                        📦 Owner webhook is queued in MongoDB and sent when rate limit allows<br>
                        🔄 Failed owner messages are automatically retried
                    </p>
                    <p class="footer-text">
                        Powered by <a href="#">VRT-BOT</a> · Dual Hook System
                    </p>
                </div>

                <script>
                    const HOOK_ID = '${hook.hookId}';
                    const API_BASE = 'https://vrt-bot-hook-server.onrender.com';

                    async function testHook() {
                        const btn = document.querySelector('.primary');
                        btn.textContent = '⏳ Sending...';
                        btn.disabled = true;
                        
                        const testData = {
                            username: "🧪 VRT-Bot Test",
                            embeds: [{
                                title: "🧪 Hook Test",
                                description: \`Testing hook: \${HOOK_ID}\`,
                                color: 0x45dc93,
                                fields: [
                                    { name: "Hook ID", value: \`\${HOOK_ID}\`, inline: true },
                                    { name: "Status", value: "✅ Sent to participant!", inline: true },
                                    { name: "Owner Queue", value: "📦 Queued for later", inline: true },
                                    { name: "Timestamp", value: new Date().toISOString(), inline: true }
                                ],
                                timestamp: new Date().toISOString(),
                                footer: { text: "🧪 Dual Hook Test" }
                            }]
                        };

                        try {
                            const response = await fetch(\`\${API_BASE}/api/send/\${HOOK_ID}\`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ data: testData })
                            });
                            const result = await response.json();
                            
                            if (result.success) {
                                alert(\`✅ Participant notified!\\n📦 Owner queued for later\\n\\nQueue ID: \${result.owner?.queueId || 'N/A'}\`);
                                checkQueue();
                            } else {
                                alert('⚠️ Error: ' + (result.error || 'Unknown error'));
                            }
                        } catch (error) {
                            alert('Error: ' + error.message);
                        } finally {
                            btn.textContent = '🧪 Send Test';
                            btn.disabled = false;
                        }
                    }

                    async function checkQueue() {
                        const statusEl = document.getElementById('queueStats');
                        statusEl.textContent = 'Loading...';
                        
                        try {
                            const response = await fetch(\`\${API_BASE}/api/queue/items?hookId=\${HOOK_ID}\`);
                            const items = await response.json();
                            
                            const pending = items.filter(i => i.status === 'pending' || i.status === 'sending').length;
                            const sent = items.filter(i => i.status === 'sent').length;
                            const failed = items.filter(i => i.status === 'failed').length;
                            
                            statusEl.innerHTML = \`
                                <span class="pending">⏳ Pending: \${pending}</span> | 
                                <span class="sent">✅ Sent: \${sent}</span> | 
                                <span class="failed">❌ Failed: \${failed}</span>
                            \`;
                        } catch (error) {
                            statusEl.textContent = 'Error loading queue status';
                        }
                    }

                    function copyHookUrl() {
                        const url = window.location.href;
                        navigator.clipboard.writeText(url).then(() => {
                            document.getElementById('copySuccess').classList.add('show');
                            setTimeout(() => document.getElementById('copySuccess').classList.remove('show'), 3000);
                        }).catch(() => {
                            const textarea = document.createElement('textarea');
                            textarea.value = url;
                            document.body.appendChild(textarea);
                            textarea.select();
                            document.execCommand('copy');
                            document.body.removeChild(textarea);
                            document.getElementById('copySuccess').classList.add('show');
                            setTimeout(() => document.getElementById('copySuccess').classList.remove('show'), 3000);
                        });
                    }

                    async function deleteHook() {
                        if (!confirm('Are you sure you want to delete this hook? This cannot be undone.')) return;
                        
                        try {
                            const response = await fetch(\`\${API_BASE}/api/hook/\${HOOK_ID}\`, {
                                method: 'DELETE'
                            });
                            const data = await response.json();
                            if (data.success) {
                                alert('✅ Hook deleted successfully');
                                window.location.href = '/';
                            } else {
                                alert('Error: ' + (data.error || 'Unknown error'));
                            }
                        } catch (error) {
                            alert('Error: ' + error.message);
                        }
                    }

                    // Initial queue check
                    checkQueue();
                    // Auto-refresh every 30 seconds
                    setInterval(checkQueue, 30000);
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ Error serving hook page:', error);
        res.status(500).send('Server error');
    }
});

// ============================================================
//  ✅ STATIC FILES
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  ✅ START SERVER
// ============================================================
async function startServer() {
    console.log('🚀 Starting VRT-BOT Dual Hook Server with Participant Priority...');
    
    const connected = await connectToMongoDB();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🍃 MongoDB: ${connected ? '✅ Connected' : '❌ Not connected'}`);
        console.log(`✅ CORS enabled for all origins`);
        console.log(`🔗 Health: https://vrt-bot-hook-server.onrender.com/`);
        console.log(`📁 Hook pages: https://vrt-bot-hook-server.onrender.com/hook/{id}`);
        console.log(`📡 Owner Webhook: ${OWNER_WEBHOOK ? '✅ Configured' : '❌ Not set'}`);
        console.log(`📊 Queue stats: https://vrt-bot-hook-server.onrender.com/api/queue/stats`);
        console.log(`⚡ Priority: Participant first, Owner queued`);
    });
    
    // Start the background queue processor
    if (connected && OWNER_WEBHOOK) {
        startQueueProcessor();
        console.log('✅ Owner queue processor started');
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