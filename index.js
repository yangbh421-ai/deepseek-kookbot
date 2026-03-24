require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');
const zlib = require('zlib');

// ===== 环境变量 =====
const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const announceChannelId = process.env.ANNOUNCE_CHANNEL_ID;

if (!token || !guildId || !pcRoleId || !consoleRoleId || !announceChannelId) {
    console.error('❌ 环境变量不完整');
    process.exit(1);
}

const API_BASE = 'https://www.kookapp.cn/api/v3';

let ws = null;
let heartbeatInterval = null;
let cardMessageId = null;

// ===== emoji 对应角色 =====
const emojiRoleMap = {
    '🖱️': pcRoleId,
    '🎮': consoleRoleId
};

// ===== API =====
const api = async (method, path, data = null) => {
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
        console.error('❌ API错误:', err.response?.data || err.message);
        throw err;
    }
};

const sendMessage = (channelId, content) =>
    api('post', '/message/create', { channel_id: channelId, content, type: 1 });

const sendCard = async () => {
    const card = [{
        type: "card",
        theme: "info",
        modules: [{
            type: "section",
            text: {
                type: "kmarkdown",
                content: "【角色自助分配】\n🖱️ PC玩家\n🎮 主机玩家"
            }
        }]
    }];

    const res = await api('post', '/message/create', {
        channel_id: announceChannelId,
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

// ===== 网关 =====
const getGateway = async () => {
    const res = await api('get', '/gateway/index');
    return res.data.url + '&compress=0';
};

const connectWS = async () => {
    const url = await getGateway();
    ws = new WebSocket(url);

    ws.on('open', () => {
        console.log('✅ 已连接KOOK');

        ws.send(JSON.stringify({
            type: 'IDENTIFY',
            token: token,
            intents: 0   // 🔥 最关键：必须是0
        }));
    });

    ws.on('message', (data, isBinary) => {
        try {
            let text;

            // ===== 自动解压 =====
            if (isBinary) {
                try {
                    text = zlib.inflateSync(data).toString();
                } catch {
                    try {
                        text = zlib.gunzipSync(data).toString();
                    } catch {
                        text = data.toString();
                    }
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

            // ===== 忽略心跳返回（避免刷屏）=====
            if (event.s === 3) return;

            // ===== HELLO（启动心跳）=====
            if (event.s === 1) {
                const interval = event.d.heartbeat_interval;

                if (heartbeatInterval) clearInterval(heartbeatInterval);

                heartbeatInterval = setInterval(() => {
                    ws.send(JSON.stringify({ s: 2 }));
                }, interval);

                console.log('💓 心跳启动');
                return;
            }

            handleEvent(event);

        } catch (err) {
            console.error('❌ WS错误:', err);
        }
    });

    ws.on('close', () => {
        console.log('❌ 断开，重连中...');
        clearInterval(heartbeatInterval);
        setTimeout(connectWS, 5000);
    });
};

// ===== 事件处理 =====
const handleEvent = (event) => {

    const data = event.d;
    if (!data) return;

    const type = data.type;

    if (type === 'MESSAGE_CREATE') {
        console.log('💬 收到:', data.content);

        if (data.content === '!sendcard') {
            (async () => {
                const res = await sendCard();
                cardMessageId = res.msg_id;

                await sendMessage(data.channel_id, '✅ 卡片已发送，点表情领角色');
            })();
        }
    }

    if (type === 'added_reaction') {
        if (data.msg_id !== cardMessageId) return;

        const role = emojiRoleMap[data.emoji.name];
        if (role) {
            console.log('👍 加角色:', data.user_id);
            grantRole(data.user_id, role);
        }
    }

    if (type === 'deleted_reaction') {
        if (data.msg_id !== cardMessageId) return;

        const role = emojiRoleMap[data.emoji.name];
        if (role) {
            console.log('👎 移除角色:', data.user_id);
            revokeRole(data.user_id, role);
        }
    }
};

// ===== 启动 =====
const start = () => {
    console.log('🚀 启动成功');
    connectWS();
};

start();
