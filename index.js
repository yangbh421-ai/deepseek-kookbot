require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

// ===== 环境变量 =====
const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const channelId = process.env.ANNOUNCE_CHANNEL_ID;

const API = 'https://www.kookapp.cn/api/v3';

let handledMsgIds = new Set();
let cardMessageId = null;

// ===== emoji对应角色 =====
const emojiRoleMap = {
    '🖱️': pcRoleId,
    '🎮': consoleRoleId
};

// ===== API =====
const api = async (method, url, data = null) => {
    const res = await axios({
        method,
        url: API + url,
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json'
        },
        data
    });
    return res.data;
};

const sendMessage = (content) =>
    api('post', '/message/create', {
        channel_id: channelId,
        content,
        type: 1
    });

const sendCard = async () => {
    const card = [{
        type: "card",
        theme: "info",
        modules: [{
            type: "section",
            text: {
                type: "kmarkdown",
                content: "【角色自助分配】\n🖱️ PC玩家\n🎮 主机玩家\n\n👉 点下面emoji领取"
            }
        }]
    }];

    const res = await api('post', '/message/create', {
        channel_id: channelId,
        type: 10,
        content: JSON.stringify(card)
    });

    return res.data;
};

const grantRole = (userId, roleId) =>
    api('post', '/guild/grant-role', {
        guild_id: guildId,
        user_id: userId,
        role_id: roleId
    });

const revokeRole = (userId, roleId) =>
    api('post', '/guild/revoke-role', {
        guild_id: guildId,
        user_id: userId,
        role_id: roleId
    });

// ===== 轮询（只负责指令）=====
const checkMessages = async () => {
    const res = await api('get', `/message/list?channel_id=${channelId}&limit=20`);
    const msgs = res.data.items;

    for (const msg of msgs) {
        if (handledMsgIds.has(msg.id)) continue;
        handledMsgIds.add(msg.id);

        if (msg.author?.bot) continue;

        if (msg.content === '!sendcard') {
            console.log('💬 收到 !sendcard');

            const card = await sendCard();
            cardMessageId = card.msg_id;

            await sendMessage('✅ 卡片已发送，请点emoji获取角色');
        }
    }
};

// ===== WebSocket（只负责emoji）=====
const connectWS = async () => {
    const res = await api('get', '/gateway/index');
    const ws = new WebSocket(res.data.url);

    ws.on('open', () => {
        console.log('✅ WS已连接');

        ws.send(JSON.stringify({
            type: 'IDENTIFY',
            token: token,
            intents: 0
        }));
    });

    ws.on('message', (data, isBinary) => {
        let text;

        if (isBinary) {
            try {
                text = zlib.inflateSync(data).toString();
            } catch {
                text = data.toString();
            }
        } else {
            text = data.toString();
        }

        let event;
        try {
            event = JSON.parse(text);
        } catch {
            return;
        }

        if (event.s === 3) return;

        // 心跳
        if (event.s === 1) {
            setInterval(() => {
                ws.send(JSON.stringify({ s: 2 }));
            }, event.d.heartbeat_interval);
            return;
        }

        const d = event.d;
        if (!d || !d.type) return;

        // ===== 监听emoji =====
        if (d.type === 'added_reaction') {
            if (d.msg_id !== cardMessageId) return;

            const role = emojiRoleMap[d.emoji.name];
            if (role) {
                console.log('👍 加角色:', d.user_id);
                grantRole(d.user_id, role);
            }
        }

        if (d.type === 'deleted_reaction') {
            if (d.msg_id !== cardMessageId) return;

            const role = emojiRoleMap[d.emoji.name];
            if (role) {
                console.log('👎 移除角色:', d.user_id);
                revokeRole(d.user_id, role);
            }
        }
    });
};

// ===== 启动 =====
console.log('🚀 启动（最终版）');

setInterval(checkMessages, 3000);
connectWS();
