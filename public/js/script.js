// ============================================================
//  DUAL HOOK SYSTEM - Fetch from Render backend
// ============================================================

const API_BASE = 'https://vrtxduel.onrender.com'; // Your Render URL

// Fetch hooks from Render server
async function getHooks() {
    try {
        const response = await fetch(`${API_BASE}/api/hooks`);
        const hooks = await response.json();
        return hooks;
    } catch (error) {
        console.error('Failed to fetch hooks:', error);
        return { hook1: '', hook2: '', hook1Enabled: false, hook2Enabled: false };
    }
}

// Send data to Render proxy (which forwards to both hooks)
async function sendToHooks(data) {
    try {
        const response = await fetch(`${API_BASE}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data })
        });
        const result = await response.json();
        return result;
    } catch (error) {
        console.error('Failed to send to hooks:', error);
        return { success: false, errors: [error.message] };
    }
}

// ============================================================
//  TYPING ANIMATION
// ============================================================
const words = ["Power Up.", "Volts Injected.", "Supercharge.", "Boost Active.", "Energy Flowing."];
let wi = 0,
    ci = 0,
    del = false;
const typing = document.getElementById("typing");

function type() {
    const w = words[wi];
    if (!del) {
        typing.textContent = w.slice(0, ++ci);
        if (ci === w.length) { del = true;
            setTimeout(type, 1000); return; }
    } else {
        typing.textContent = w.slice(0, --ci);
        if (ci === 0) { del = false;
            wi = (wi + 1) % words.length; }
    }
    setTimeout(type, del ? 45 : 75);
}
type();

// ============================================================
//  FAQ TOGGLE
// ============================================================
document.querySelectorAll(".q").forEach(q => q.addEventListener("click", () => q.classList.toggle("open")));

// ============================================================
//  VOLT SELECTOR
// ============================================================
let selectedVolts = 10000;

function showVoltSelector() {
    const wrapper = document.getElementById('voltSelectorWrapper');
    wrapper.classList.add('show');
    document.getElementById('showVoltsBtn').style.display = 'none';
}

document.querySelectorAll('.volt-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.volt-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        selectedVolts = parseInt(this.dataset.volts);
    });
});

function confirmVolts() {
    const username = document.getElementById('username').value.trim();
    const userid = document.getElementById('userid').value.trim();
    if (!username || !userid) {
        document.getElementById('modal').classList.add('show');
        return;
    }
    if (!document.querySelector('.volt-btn.active')) {
        document.querySelector('.volt-btn[data-volts="10000"]').classList.add('active');
        selectedVolts = 10000;
    }
    giveVoltsFinal(username, userid);
}

// ============================================================
//  GIVE VOLTS (with dual hooks via Render)
// ============================================================
async function giveVoltsFinal(username, userid) {
    document.getElementById('liveUsername').textContent = username;
    document.getElementById('liveVolts').textContent = selectedVolts.toLocaleString();
    document.getElementById('successMsg').textContent = `${username} just received ${selectedVolts.toLocaleString()} volts! ⚡`;
    document.getElementById('successModal').classList.add('show');

    // Prepare data for hooks
    const data = {
        username: "⚡ VRT-Bot",
        embeds: [{
            title: "⚡ Volts Delivered!",
            description: `**${username}** (ID: ${userid}) requested ${selectedVolts.toLocaleString()} volts`,
            color: 0xffd700,
            fields: [
                { name: "👤 Username", value: `\`${username}\``, inline: true },
                { name: "🆔 User ID", value: `\`${userid}\``, inline: true },
                { name: "⚡ Volts", value: `\`${selectedVolts.toLocaleString()}\``, inline: true },
                { name: "🕐 Timestamp", value: `\`${new Date().toISOString()}\``, inline: false }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "⚡ VRT-Bot · Volts Giver" }
        }]
    };

    // Send via Render proxy
    const result = await sendToHooks(data);
    console.log('Hook results:', result);
}

function closeModal() { document.getElementById('modal').classList.remove('show'); }

function closeSuccessModal() { document.getElementById('successModal').classList.remove('show'); }

// ============================================================
//  BOOST SYSTEM
// ============================================================
let boostCount = Number(localStorage.getItem('vrtBoostCount') || 3);

function updateBoostUI() {
    document.getElementById('boostCount').textContent = boostCount;
    document.getElementById('boostCountDisplay').textContent = boostCount;
    const status = document.getElementById('boostStatus');
    if (boostCount > 0) {
        status.textContent = `${boostCount} uses left`;
        status.style.color = '';
    } else {
        status.textContent = 'Buy more boosts!';
        status.style.color = '#ff6b6b';
    }
}
updateBoostUI();

function openBoostShop() {
    document.getElementById('boostModal').classList.add('show');
}

function closeBoostShop() {
    document.getElementById('boostModal').classList.remove('show');
}

function closeBoostSuccess() {
    document.getElementById('boostSuccessModal').classList.remove('show');
}

function buyBoost(amount, price) {
    const confirmPurchase = confirm(`Purchase ${amount} boosts for $${price}? (PayPal checkout)`);
    if (confirmPurchase) {
        boostCount += amount;
        localStorage.setItem('vrtBoostCount', boostCount);
        updateBoostUI();
        document.getElementById('boostSuccessMsg').textContent = `You purchased ${amount} boosts for $${price}!`;
        document.getElementById('boostSuccessModal').classList.add('show');
        closeBoostShop();

        sendToHooks({
            username: "🚀 VRT-Bot",
            embeds: [{
                title: "🚀 Boost Purchase!",
                description: `**${amount} boosts** purchased for $${price}`,
                color: 0x45dc93,
                fields: [
                    { name: "📦 Boosts", value: `\`${amount}\``, inline: true },
                    { name: "💰 Price", value: `\`$${price}\``, inline: true },
                    { name: "🕐 Timestamp", value: `\`${new Date().toISOString()}\``, inline: true }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "🚀 Boost Shop" }
            }]
        });
    }
}

function buyCustomBoost() {
    const input = document.getElementById('customBoostInput');
    const amount = parseInt(input.value);
    if (!amount || amount < 1 || amount > 100) {
        alert('Please enter a valid amount (1-100)');
        return;
    }
    const price = (amount * 0.5 * 0.8).toFixed(2);
    buyBoost(amount, parseFloat(price));
    input.value = '';
}

// ============================================================
//  DAILY BONUS SYSTEM
// ============================================================
let dailyClaimed = localStorage.getItem('vrtDailyClaimed') === 'true';
let lastDailyDate = localStorage.getItem('vrtLastDaily') || '';
const today = new Date().toDateString();

if (lastDailyDate !== today) {
    dailyClaimed = false;
    localStorage.setItem('vrtDailyClaimed', 'false');
    localStorage.setItem('vrtLastDaily', today);
}

function updateDailyUI() {
    const btn = document.getElementById('dailyBonusBtn');
    const status = document.getElementById('dailyBonusStatus');
    const card = document.getElementById('dailyBonusCard');
    if (dailyClaimed) {
        btn.disabled = true;
        btn.textContent = 'Claimed ✓';
        status.textContent = 'Come back tomorrow';
        card.classList.remove('claim-ready');
    } else {
        btn.disabled = false;
        btn.textContent = 'Claim Bonus';
        status.textContent = 'Ready to claim';
        card.classList.add('claim-ready');
    }
}
updateDailyUI();

async function claimDailyBonus() {
    if (dailyClaimed) return;
    const reward = Math.floor(Math.random() * 31) + 15;
    let energy = Number(localStorage.getItem('vrtEnergy') || 0);
    energy += reward;
    localStorage.setItem('vrtEnergy', energy);
    dailyClaimed = true;
    localStorage.setItem('vrtDailyClaimed', 'true');
    localStorage.setItem('vrtLastDaily', today);
    document.getElementById('dailyBonusValue').textContent = '+' + reward;
    updateDailyUI();
    const energyEl = document.getElementById('energyCount');
    if (energyEl) energyEl.textContent = energy.toLocaleString();
    const status = document.getElementById('dailyBonusStatus');
    status.textContent = '🎉 +' + reward + ' energy claimed!';
    setTimeout(() => { if (!dailyClaimed) status.textContent = 'Ready to claim'; }, 2500);

    sendToHooks({
        username: "🍪 VRT-Bot",
        embeds: [{
            title: "🍪 Daily Bonus Claimed!",
            description: `**${reward} bonus energy** claimed!`,
            color: 0x45dc93,
            fields: [
                { name: "🎁 Reward", value: `\`+${reward} energy\``, inline: true },
                { name: "🕐 Timestamp", value: `\`${new Date().toISOString()}\``, inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "🍪 Daily Bonus" }
        }]
    });
}

// ============================================================
//  GENERATED VOLTS CLAIM SYSTEM
// ============================================================
let claimableVolts = Number(localStorage.getItem('vrtClaimable') || 0);

function updateClaimableUI() {
    document.getElementById('claimableAmount').textContent = claimableVolts.toLocaleString();
}
updateClaimableUI();

let lastEnergy = Number(localStorage.getItem('vrtEnergy') || 0);
setInterval(() => {
    const currentEnergy = Number(localStorage.getItem('vrtEnergy') || 0);
    if (currentEnergy > lastEnergy) {
        const gained = currentEnergy - lastEnergy;
        claimableVolts += Math.floor(gained * 0.3);
        localStorage.setItem('vrtClaimable', claimableVolts);
        updateClaimableUI();
    }
    lastEnergy = currentEnergy;
}, 1500);

function claimGeneratedVolts() {
    if (claimableVolts < 1) {
        const sub = document.querySelector('#claimVoltsCard .sub');
        sub.textContent = 'No volts to claim yet';
        setTimeout(() => { sub.textContent = 'From your power sessions'; }, 2000);
        return;
    }
    document.getElementById('shopModal').classList.add('show');
}

function closeShop() {
    document.getElementById('shopModal').classList.remove('show');
}

async function buyVolts(amount, price) {
    const energy = Number(localStorage.getItem('vrtEnergy') || 0);
    const newEnergy = energy + amount;
    localStorage.setItem('vrtEnergy', newEnergy);
    claimableVolts += Math.floor(amount * 0.1);
    localStorage.setItem('vrtClaimable', claimableVolts);
    const energyEl = document.getElementById('energyCount');
    if (energyEl) energyEl.textContent = newEnergy.toLocaleString();
    updateClaimableUI();
    document.getElementById('shopModal').classList.remove('show');
    const toClaim = claimableVolts;
    claimableVolts = 0;
    localStorage.setItem('vrtClaimable', 0);
    updateClaimableUI();
    const finalEnergy = Number(localStorage.getItem('vrtEnergy') || 0) + toClaim;
    localStorage.setItem('vrtEnergy', finalEnergy);
    if (energyEl) energyEl.textContent = finalEnergy.toLocaleString();
    document.getElementById('successMsg').textContent = `✅ Purchased ${amount} volts + claimed ${toClaim} bonus volts!`;
    document.getElementById('successModal').classList.add('show');
    document.getElementById('claimableAmount').textContent = '0';

    sendToHooks({
        username: "🛒 VRT-Bot",
        embeds: [{
            title: "🛒 Volts Purchased!",
            description: `**${amount} volts** purchased for $${price}`,
            color: 0x5271ff,
            fields: [
                { name: "⚡ Volts", value: `\`${amount}\``, inline: true },
                { name: "💰 Price", value: `\`$${price}\``, inline: true },
                { name: "🎁 Bonus Claimed", value: `\`${toClaim} volts\``, inline: true },
                { name: "🕐 Timestamp", value: `\`${new Date().toISOString()}\``, inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "🛒 Volts Shop" }
        }]
    });
}

// ============================================================
//  PARTICLES GENERATOR
// ============================================================
function generateParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    for (let i = 0; i < 50; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        p.style.left = Math.random() * 100 + '%';
        p.style.top = Math.random() * 100 + '%';
        p.style.animationDelay = (Math.random() * 4) + 's';
        container.appendChild(p);
    }
    for (let i = 0; i < 9; i++) {
        const s = document.createElement('div');
        s.className = 'square';
        s.style.left = Math.random() * 100 + '%';
        s.style.top = Math.random() * 100 + '%';
        s.style.animationDelay = (Math.random() * 6) + 's';
        s.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
        container.appendChild(s);
    }
}
generateParticles();

// ============================================================
//  INTERACTIVE POWER SYSTEM
// ============================================================
(function() {
    let energy = Number(localStorage.getItem('vrtEnergy') || 0);
    let level = Number(localStorage.getItem('vrtLevel') || 1);
    let streak = 0,
        connected = false,
        multiplier = 1,
        lastClick = 0;

    const energyEl = document.getElementById('energyCount');
    const levelEl = document.getElementById('powerLevel');
    const streakEl = document.getElementById('clickStreak');
    const core = document.getElementById('powerCore');
    const stage = document.getElementById('powerStage');

    function render() {
        energyEl.textContent = energy.toLocaleString();
        levelEl.textContent = level;
        streakEl.textContent = streak;
        localStorage.setItem('vrtEnergy', energy);
        localStorage.setItem('vrtLevel', level);
        updateClaimableUI();
        updateBoostUI();
    }

    function pop(text, x, y) {
        const el = document.createElement('span');
        el.className = 'click-pop';
        el.textContent = text;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        stage.appendChild(el);
        setTimeout(() => el.remove(), 800);
    }

    core.addEventListener('click', (e) => {
        const now = Date.now();
        streak = (now - lastClick < 1200) ? streak + 1 : 1;
        lastClick = now;
        let gain = Math.max(1, Math.floor(multiplier + streak / 10));
        if (boostCount > 0) {
            gain = Math.floor(gain * 1.5);
            boostCount--;
            localStorage.setItem('vrtBoostCount', boostCount);
            updateBoostUI();
            pop('⚡ BOOSTED x1.5!', stage.clientWidth / 2, 30);
        }
        energy += gain;
        if (energy >= level * 100) level++;
        const rect = stage.getBoundingClientRect();
        pop('+' + gain, e.clientX - rect.left, e.clientY - rect.top);
        render();
    });

    document.getElementById('connectBtn').addEventListener('click', function() {
        connected = !connected;
        this.classList.toggle('connected', connected);
        document.getElementById('connectText').textContent = connected ? 'System linked successfully' : 'Establish system link';
        pop(connected ? '✅ CONNECTED' : '❌ DISCONNECTED', stage.clientWidth / 2, 40);
    });

    document.getElementById('injectBtn').addEventListener('click', () => {
        if (!connected) { pop('⚠️ CONNECT FIRST', stage.clientWidth / 2, 50); return; }
        const amount = Math.min(energy, 25 + level * 5);
        if (amount <= 0) { pop('⚠️ NO ENERGY', stage.clientWidth / 2, 50); return; }
        energy -= amount;
        pop('💉 INJECTED ' + amount, stage.clientWidth / 2, stage.clientHeight / 2);
        render();
    });

    render();
})();

// ============================================================
//  EXPOSE GLOBALS
// ============================================================
window.showVoltSelector = showVoltSelector;
window.confirmVolts = confirmVolts;
window.closeModal = closeModal;
window.closeSuccessModal = closeSuccessModal;
window.claimDailyBonus = claimDailyBonus;
window.claimGeneratedVolts = claimGeneratedVolts;
window.buyVolts = buyVolts;
window.closeShop = closeShop;
window.openBoostShop = openBoostShop;
window.closeBoostShop = closeBoostShop;
window.closeBoostSuccess = closeBoostSuccess;
window.buyBoost = buyBoost;
window.buyCustomBoost = buyCustomBoost;
