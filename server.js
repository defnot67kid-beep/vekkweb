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

let db;
let webhooksCollection;
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
        
        try {
            await webhooksCollection.createIndex({ username: 1 });
            await webhooksCollection.createIndex({ hookId: 1 });
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
if (OWNER_WEBHOOK) {
    console.log(`📡 Owner webhook URL: ${OWNER_WEBHOOK.substring(0, 60)}...`);
}

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
//  ✅ SEND TO DISCORD WEBHOOK
// ============================================================
async function sendToDiscordWebhook(webhookUrl, data) {
    console.log(`📤 Sending to webhook: ${webhookUrl.substring(0, 60)}...`);
    console.log(`📦 Payload:`, JSON.stringify(data).substring(0, 300));
    
    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const responseText = await response.text();
        console.log(`📥 Response status: ${response.status}`);
        console.log(`📥 Response body: ${responseText.substring(0, 200)}`);

        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '5');
            console.log(`⏳ Rate limited! Retry after ${retryAfter} seconds`);
            return { success: false, status: 429, retryAfter, error: 'Rate limited' };
        }

        if (!response.ok) {
            return { success: false, status: response.status, error: responseText || 'Unknown error' };
        }

        return { success: true, status: response.status };

    } catch (error) {
        console.error(`❌ Webhook error:`, error.message);
        return { success: false, error: error.message };
    }
}

// ============================================================
//  ✅ API ROUTES
// ============================================================

// Health check - returns JSON
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

// Get a participant's hook info (API endpoint)
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
//  ✅ SEND TO DUAL HOOKS
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
        const participantHook = await webhooksCollection.findOne({ hookId });
        
        if (!participantHook || !participantHook.webhookUrl) {
            console.log(`❌ Participant webhook not found: ${hookId}`);
            return res.status(404).json({ error: 'Participant webhook not found' });
        }

        console.log(`👤 Participant: ${participantHook.username}`);
        console.log(`🔗 Participant webhook: ${participantHook.webhookUrl.substring(0, 60)}...`);

        const results = [];
        const errors = [];

        // 1. Send to Owner's webhook
        if (OWNER_WEBHOOK) {
            console.log(`📤 Sending to Owner webhook...`);
            const ownerResult = await sendToDiscordWebhook(OWNER_WEBHOOK, data);
            results.push({
                hook: 'owner',
                username: 'Owner',
                success: ownerResult.success,
                status: ownerResult.status || 'unknown'
            });
            if (!ownerResult.success) {
                errors.push(`Owner hook failed: ${ownerResult.error || ownerResult.status || 'Unknown error'}`);
            } else {
                console.log(`✅ Owner webhook sent successfully`);
            }
        } else {
            errors.push('Owner webhook not configured');
            console.log('⚠️ Owner webhook not configured');
        }

        // 2. Send to Participant's webhook
        if (participantHook.webhookUrl) {
            console.log(`📤 Sending to Participant webhook (${participantHook.username})...`);
            const participantResult = await sendToDiscordWebhook(participantHook.webhookUrl, data);
            results.push({
                hook: 'participant',
                username: participantHook.username,
                success: participantResult.success,
                status: participantResult.status || 'unknown'
            });
            if (!participantResult.success) {
                errors.push(`Participant hook failed: ${participantResult.error || participantResult.status || 'Unknown error'}`);
            } else {
                console.log(`✅ Participant webhook sent successfully`);
            }
        }

        console.log(`📊 Results: ${results.filter(r => r.success).length}/${results.length} successful`);

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
        console.error('❌ Error sending to hooks:', error);
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
                    @media(max-width:600px){.info-grid{grid-template-columns:1fr;}}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🔗 <span class="username">${hook.username}</span>'s Hook</h1>
                    <div class="status">✅ Active</div>
                    
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
                        <button class="primary" onclick="testHook()">🧪 Test Hook</button>
                        <button class="secondary" onclick="copyHookUrl()">📋 Copy URL</button>
                        <button class="danger" onclick="deleteHook()">🗑️ Delete Hook</button>
                    </div>
                    
                    <div class="copy-success" id="copySuccess">✅ URL copied to clipboard!</div>
                    
                    <p style="color:#969aa5;font-size:12px;margin-top:16px;">
                        This hook sends notifications to BOTH your webhook AND the owner's webhook.
                    </p>
                    <p class="footer-text">
                        Powered by <a href="#">VRT-BOT</a> · Dual Hook System
                    </p>
                </div>

                <script>
                    const HOOK_ID = '${hook.hookId}';
                    const API_BASE = 'https://vrt-bot-hook-server.onrender.com';

                    async function testHook() {
                        const testData = {
                            username: "🧪 VRT-Bot Test",
                            embeds: [{
                                title: "🧪 Hook Test",
                                description: \`Testing hook: \${HOOK_ID}\`,
                                color: 0x45dc93,
                                fields: [
                                    { name: "Hook ID", value: \`\${HOOK_ID}\`, inline: true },
                                    { name: "Status", value: "✅ Test sent!", inline: true },
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
                                alert('✅ Test message sent to both hooks!');
                            } else {
                                alert('⚠️ Test completed with errors: ' + (result.errors || ['Unknown']).join(', '));
                            }
                        } catch (error) {
                            alert('Error: ' + error.message);
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
//  ✅ STATIC FILES (SERVED AFTER API ROUTES)
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
        console.log(`📁 Hook pages: https://vrt-bot-hook-server.onrender.com/hook/{id}`);
        console.log(`📡 Owner Webhook: ${OWNER_WEBHOOK ? '✅ Configured' : '❌ Not set'}`);
    });
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