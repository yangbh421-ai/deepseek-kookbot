require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

// ========== 环境变量 ==========
const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const announceChannelId = process.env.ANNOUNCE_CHANNEL_ID;
const adminRoleId = process.env.ADMIN_ROLE_ID;

if (!token || !guildId || !pcRoleId || !consoleRoleId || !announceChannelId) {
    console.error('❌ 缺少必要的环境变量');
    process.exit(1);
}

const API_BASE = 'https://www.kookapp.cn/api/v3';
const CARD_MARKER = '【角色自助分配卡片】请点击下方表情获取对应角色：';

let cardMessageId = null;
let ws = null;
let heartbeatInterval = null;

const emojiRoleMap = {
    '🖱️': pcRoleId,
    '🎮': consoleRoleId
};

// ========== API ==========
const apiRequest = async (method, path, data = null) => {
    try {
        const res = await axios({
            method,
            url: API_BASE + path,
            headers: {
                Authorization: `Bot ${token}`,
                'Content-Type': 'application/json'
            },
            data
        });
        return res.data;
    } catch (err) {
        console.error('API错误:', err.response?.data || err.message);
        throw err;
    }
};

const sendMessage = (channelId, content) =>
    apiRequest('post', '/message/create', { channel_id: channelId, content, type: 1 });

const sendCardMessage = (channelId, card) =>
    apiRequest('post', '/message/create', {
        channel_id: channelId,
        type: 10,
        content: JSON.stringify(card)
    });

const grantRole = (userId, roleId) =>
    apiRequest('post', '/guild/grant-role', {
        guild_id: guildId,
        user_id: userId,
        role_id: roleId
    });

const revokeRole = (userId, roleId) =>
    apiRequest('post', '/guild/revoke-role', {
        guild_id: guildId,
        user_id: userId,
        role_id: roleId
    });

const getMessages = async () => {
    const res = await apiRequest('get', `/message/list?channel_id=${announceChannelId}&limit=50`);
    return res.data?.items || [];
};

const getMessage = async (msgId) => {
    const res = await apiRequest('get', `/message/view?msg_id=${msgId}`);
    return res.data;
};

// ========== 卡片 ==========
const findExistingCard = async () => {
    const list = await getMessages();
    return list.find(m => m.content.includes(CARD_MARKER));
};

const sendRoleCard = async () => {
    const card = [{
        type: "card",
        theme: "info",
        modules: [
            {
                type: "section",
                text: {
                    type: "kmarkdown",
                    content: `${CARD_MARKER}\n🖱️ PC平台\n🎮 主机平台`
                }
            }
        ]
    }];

    const res = await sendCardMessage(announceChannelId, card);
    return res.data;
};

// ========== 同步 ==========
const syncRoles = async () => {
    if (!cardMessageId) return;

    console.log('🔄 同步角色...');

    const msg = await getMessage(cardMessageId);

    for (const [emoji, roleId] of Object.entries(emojiRoleMap)) {
        const reaction = msg.reactions?.find(r => r.emoji.name === emoji);
        if (!reaction) continue;

        for (const user of reaction.users || []) {
            await grantRole(user.id, roleId).catch(() => {});
        }
    }
};

// ========== 网关 ==========
const getGateway = async () => {
    const res = await apiRequest('get', '/gateway/index');
    return res.data.url + '&compress=0';
};

const connectWS = async () => {
    const url = await getGateway();
    ws = new WebSocket(url);

    ws.on('open', () => {
        console.log('✅ WS连接成功');

        ws.send(JSON.stringify({
            type: 'IDENTIFY',
            token,
            intents: 513
        }));
    });

    ws.on('message', (msg) => {
        let event;

        try {
            event = JSON.parse(msg.toString());
        } catch {
            console.log('解析失败:', msg.toString().slice(0, 100));
            return;
        }

        console.log('📩 收到事件:', event.type);

        if (event.type === 'HELLO') {
            const interval = event.data.heartbeat_interval;
            heartbeatInterval = setInterval(() => {
                ws.send(JSON.stringify({ type: 'PING' }));
            }, interval);
            return;
        }

        if (event.type === 'PONG') return;

        handleEvent(event);
    });

    ws.on('close', () => {
        console.log('❌ WS断开，5秒重连');
        clearInterval(heartbeatInterval);
        setTimeout(connectWS, 5000);
    });
};

// ========== 事件 ==========
const handleEvent = (event) => {
    const { type, data } = event;

    if (!data) return;

    // 🔥 关键日志
    console.log('👉 事件数据:', JSON.stringify(data).slice(0, 200));

    switch (type) {

        case 'MESSAGE_CREATE':
            if (data.content === '!sendcard') {
                (async () => {
                    const res = await sendRoleCard();
                    cardMessageId = res.msg_id;
                    await sendMessage(data.channel_id, '✅ 卡片已发送');
                })();
            }
            break;

        case 'added_reaction':
            if (data.msg_id !== cardMessageId) return;

            console.log('👍 添加反应:', data.emoji.name);

            const roleAdd = emojiRoleMap[data.emoji.name];
            if (roleAdd) {
                grantRole(data.user_id, roleAdd);
            }
            break;

        case 'deleted_reaction':
            if (data.msg_id !== cardMessageId) return;

            console.log('👎 移除反应:', data.emoji.name);

            const roleRemove = emojiRoleMap[data.emoji.name];
            if (roleRemove) {
                revokeRole(data.user_id, roleRemove);
            }
            break;
    }
};

// ========== 启动 ==========
const start = async () => {
    console.log('🚀 启动机器人');

    const existing = await findExistingCard();

    if (existing) {
        cardMessageId = existing.msg_id;
        console.log('✅ 找到卡片:', cardMessageId);
        await syncRoles();
    } else {
        console.log('⚠️ 没有卡片，请发送 !sendcard');
    }

    connectWS();
};

start();
