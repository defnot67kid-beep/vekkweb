const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: ['https://vrtvoltsxyc.netlify.app', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// ============================================================
//  OWNER'S HARDCODED WEBHOOK (from .env)
// ============================================================
const OWNER_WEBHOOK = process.env.OWNER_WEBHOOK_URL || '';
const WEBHOOKS_FILE = path.join(__dirname, 'webhooks.json');

// ============================================================
//  STORAGE: webhooks.json
// ============================================================
function loadWebhooks() {
    try {
        if (fs.existsSync(WEBHOOKS_FILE)) {
            const data = fs.readFileSync(WEBHOOKS_FILE, 'utf8');
            return JSON.parse(data);
        }
        return {};
    } catch (e) {
        return {};
    }
}

function saveWebhooks(webhooks) {
    fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2));
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
//  ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'VRT-BOT Dual Hook Server',
        ownerWebhookConfigured: !!OWNER_WEBHOOK,
        registeredHooks: Object.keys(loadWebhooks()).length,
        timestamp: new Date().toISOString()
    });
});

// Generate a new unique hook URL for a participant
app.post('/api/generate', (req, res) => {
    const { username, webhookUrl } = req.body;
    
    if (!username || !webhookUrl) {
        return res.status(400).json({ error: 'Username and webhook URL required' });
    }

    // Validate webhook URL
    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
        return res.status(400).json({ error: 'Invalid Discord webhook URL' });
    }

    const webhooks = loadWebhooks();
    
    // Check if user already has a hook
    let existingId = null;
    for (const [id, data] of Object.entries(webhooks)) {
        if (data.username === username) {
            existingId = id;
            break;
        }
    }

    if (existingId) {
        // Update existing webhook
        webhooks[existingId] = {
            username,
            webhookUrl,
            createdAt: webhooks[existingId].createdAt,
            updatedAt: new Date().toISOString()
        };
        saveWebhooks(webhooks);
        return res.json({
            success: true,
            message: 'Webhook updated successfully',
            hookId: existingId,
            hookUrl: `https://${req.get('host')}/hook/${existingId}`,
            isNew: false
        });
    }

    // Generate new ID
    let id = generateId();
    while (webhooks[id]) {
        id = generateId(); // Regenerate if collision
    }

    webhooks[id] = {
        username,
        webhookUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    saveWebhooks(webhooks);

    res.json({
        success: true,
        message: 'Webhook registered successfully',
        hookId: id,
        hookUrl: `https://${req.get('host')}/hook/${id}`,
        isNew: true
    });
});

// Get a participant's hook info
app.get('/api/hook/:id', (req, res) => {
    const { id } = req.params;
    const webhooks = loadWebhooks();
    
    if (!webhooks[id]) {
        return res.status(404).json({ error: 'Hook not found' });
    }

    res.json({
        id,
        username: webhooks[id].username,
        createdAt: webhooks[id].createdAt,
        webhookConfigured: !!webhooks[id].webhookUrl
    });
});

// Get all registered hooks (for owner dashboard)
app.get('/api/hooks/all', (req, res) => {
    const webhooks = loadWebhooks();
    const list = Object.entries(webhooks).map(([id, data]) => ({
        id,
        username: data.username,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        webhookConfigured: !!data.webhookUrl
    }));
    res.json(list);
});

// Delete a hook (for owner)
app.delete('/api/hook/:id', (req, res) => {
    const { id } = req.params;
    const webhooks = loadWebhooks();
    
    if (!webhooks[id]) {
        return res.status(404).json({ error: 'Hook not found' });
    }

    delete webhooks[id];
    saveWebhooks(webhooks);
    res.json({ success: true, message: 'Hook deleted' });
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

    const webhooks = loadWebhooks();
    const participantHook = webhooks[hookId];

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
});

// ============================================================
//  SERVE CUSTOM HOOK PAGES (Netlify will handle this)
//  We just provide the data, Netlify serves the HTML
// ============================================================
app.get('/hook/:id', (req, res) => {
    const { id } = req.params;
    const webhooks = loadWebhooks();
    
    if (!webhooks[id]) {
        return res.status(404).send(`
            <!DOCTYPE html>
            <html>
            <head><title>Hook Not Found</title></head>
            <body style="font-family:sans-serif;background:#0e0f11;color:#fff;display:grid;place-items:center;height:100vh;margin:0;">
                <div style="text-align:center;">
                    <h1>🔗 Hook Not Found</h1>
                    <p style="color:#969aa5;">This hook ID does not exist or has been removed.</p>
                    <a href="/" style="color:#5271ff;">Return to VRT-BOT</a>
                </div>
            </body>
            </html>
        `);
    }

    // Return the hook data as JSON for the frontend to render
    res.json({
        id,
        username: webhooks[id].username,
        createdAt: webhooks[id].createdAt,
        webhookConfigured: !!webhooks[id].webhookUrl
    });
});

// ============================================================
//  START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 VRT-BOT Dual Hook Server running on port ${PORT}`);
    console.log(`🔗 Owner Webhook: ${OWNER_WEBHOOK ? '✅ Configured' : '❌ Not set'}`);
    console.log(`📁 Registered hooks: ${Object.keys(loadWebhooks()).length}`);
    console.log(`🔗 Health: http://localhost:${PORT}/`);
});