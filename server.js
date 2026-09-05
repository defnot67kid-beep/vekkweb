const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: ['https://vrtvoltsxyc.netlify.app', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true
}));
app.use(express.json());

// ============================================================
//  ENVIRONMENT VARIABLES (Set these in Render Dashboard)
// ============================================================
// WEBHOOK_URL_1  - Primary Discord webhook
// WEBHOOK_URL_2  - Backup Discord webhook (optional)
// WEBHOOK_ENABLED_1 - true/false
// WEBHOOK_ENABLED_2 - true/false

const WEBHOOK_1 = process.env.WEBHOOK_URL_1 || '';
const WEBHOOK_2 = process.env.WEBHOOK_URL_2 || '';
const WEBHOOK_1_ENABLED = process.env.WEBHOOK_ENABLED_1 !== 'false';
const WEBHOOK_2_ENABLED = process.env.WEBHOOK_ENABLED_2 !== 'false';

// ============================================================
//  ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'VRT-BOT Hook Server',
        hooks: {
            hook1: WEBHOOK_1 ? 'Configured' : 'Not set',
            hook2: WEBHOOK_2 ? 'Configured' : 'Not set',
            hook1Enabled: WEBHOOK_1_ENABLED,
            hook2Enabled: WEBHOOK_2_ENABLED
        },
        timestamp: new Date().toISOString()
    });
});

// Get hook configuration (for frontend)
app.get('/api/hooks', (req, res) => {
    res.json({
        hook1: WEBHOOK_1,
        hook2: WEBHOOK_2,
        hook1Enabled: WEBHOOK_1_ENABLED,
        hook2Enabled: WEBHOOK_2_ENABLED
    });
});

// Proxy webhook requests (send data to both hooks)
app.post('/api/send', async (req, res) => {
    const { data } = req.body;
    if (!data) {
        return res.status(400).json({ error: 'Missing data' });
    }

    const results = [];
    const errors = [];

    // Send to Hook 1
    if (WEBHOOK_1 && WEBHOOK_1_ENABLED) {
        try {
            const response = await fetch(WEBHOOK_1, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            results.push({
                hook: 1,
                success: response.ok,
                status: response.status
            });
            if (!response.ok) {
                errors.push(`Hook 1 failed: ${response.status}`);
            }
        } catch (e) {
            errors.push(`Hook 1 error: ${e.message}`);
            results.push({ hook: 1, success: false, error: e.message });
        }
    }

    // Send to Hook 2
    if (WEBHOOK_2 && WEBHOOK_2_ENABLED) {
        try {
            const response = await fetch(WEBHOOK_2, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            results.push({
                hook: 2,
                success: response.ok,
                status: response.status
            });
            if (!response.ok) {
                errors.push(`Hook 2 failed: ${response.status}`);
            }
        } catch (e) {
            errors.push(`Hook 2 error: ${e.message}`);
            results.push({ hook: 2, success: false, error: e.message });
        }
    }

    res.json({
        success: results.some(r => r.success),
        results,
        errors: errors.length > 0 ? errors : null
    });
});

// Test endpoint - sends a test message to both hooks
app.post('/api/test', async (req, res) => {
    const { username = 'TestUser', volts = '1000' } = req.body;

    const testData = {
        username: "🧪 VRT-Bot Test",
        embeds: [{
            title: "🧪 Test Message from Server",
            description: `**${username}** - ${volts} volts test`,
            color: 0x45dc93,
            fields: [
                { name: "Status", value: "✅ Server is online", inline: true },
                { name: "Timestamp", value: new Date().toISOString(), inline: true },
                { name: "Server", value: "Render.com", inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "🧪 Server Test" }
        }]
    };

    const results = [];
    const errors = [];

    if (WEBHOOK_1 && WEBHOOK_1_ENABLED) {
        try {
            const response = await fetch(WEBHOOK_1, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testData)
            });
            results.push({ hook: 1, success: response.ok, status: response.status });
            if (!response.ok) errors.push(`Hook 1: ${response.status}`);
        } catch (e) {
            errors.push(`Hook 1: ${e.message}`);
            results.push({ hook: 1, success: false, error: e.message });
        }
    }

    if (WEBHOOK_2 && WEBHOOK_2_ENABLED) {
        try {
            const response = await fetch(WEBHOOK_2, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testData)
            });
            results.push({ hook: 2, success: response.ok, status: response.status });
            if (!response.ok) errors.push(`Hook 2: ${response.status}`);
        } catch (e) {
            errors.push(`Hook 2: ${e.message}`);
            results.push({ hook: 2, success: false, error: e.message });
        }
    }

    res.json({
        success: results.some(r => r.success),
        results,
        errors: errors.length > 0 ? errors : null,
        hooks: {
            hook1Configured: !!WEBHOOK_1,
            hook2Configured: !!WEBHOOK_2,
            hook1Enabled: WEBHOOK_1_ENABLED,
            hook2Enabled: WEBHOOK_2_ENABLED
        }
    });
});

// ============================================================
//  START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 VRT-BOT Hook Server running on port ${PORT}`);
    console.log(`📡 Hook 1: ${WEBHOOK_1 ? 'Configured' : 'Not set'}`);
    console.log(`📡 Hook 2: ${WEBHOOK_2 ? 'Configured' : 'Not set'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/`);
    console.log(`📡 API: http://localhost:${PORT}/api/hooks`);
});