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
const CARD_MARKER = '【角色自助分配卡片】请点击下方表情获取对应角色：';

let ws = null;
let heartbeatInterval = null;
let cardMessageId = null;

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
        console.error('API错误:', err.response?.data || err.message);
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
                content: `${CARD_MARKER}\n🖱️ PC平台\n🎮 主机平台`
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
        console.log('✅ WS连接成功');

        ws.send(JSON.stringify({
            type: 'IDENTIFY',
            token: token,
            intents: 513
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
                console.log('❌ JSON解析失败:', text.slice(0, 100));
                return;
            }

            console.log('📩 收到事件:', event.type);

            // ===== 心跳 =====
            if (event.type === 'HELLO') {
                const interval = event.data.heartbeat_interval;

                if (heartbeatInterval) clearInterval(heartbeatInterval);

                heartbeatInterval = setInterval(() => {
                    ws.send(JSON.stringify({ type: 'PING' }));
                }, interval);

                console.log('💓 心跳启动:', interval);
                return;
            }

            if (event.type === 'PONG') return;

            handleEvent(event);

        } catch (err) {
            console.error('❌ WS错误:', err);
        }
    });

    ws.on('close', () => {
        console.log('❌ WS断开，5秒重连');
        clearInterval(heartbeatInterval);
        setTimeout(connectWS, 5000);
    });

    ws.on('error', (err) => {
        console.error('WS错误:', err);
        ws.close();
    });
};

// ===== 事件 =====
const handleEvent = (event) => {
    const { type, data } = event;
    if (!data) return;

    switch (type) {

        case 'MESSAGE_CREATE':
            console.log('💬 收到消息:', data.content);

            if (data.content === '!sendcard') {
                (async () => {
                    try {
                        const res = await sendCard();
                        cardMessageId = res.msg_id;

                        await sendMessage(data.channel_id, '✅ 卡片已发送，请点击表情领取角色');

                        console.log('✅ 卡片发送成功:', cardMessageId);
                    } catch (err) {
                        console.error('发送失败:', err);
                    }
                })();
            }
            break;

        case 'added_reaction':
            if (data.msg_id !== cardMessageId) return;

            console.log('👍 添加反应:', data.emoji.name);

            const roleAdd = emojiRoleMap[data.emoji.name];
            if (roleAdd) {
                grantRole(data.user_id, roleAdd)
                    .catch(err => console.error('加角色失败:', err.message));
            }
            break;

        case 'deleted_reaction':
            if (data.msg_id !== cardMessageId) return;

            console.log('👎 移除反应:', data.emoji.name);

            const roleRemove = emojiRoleMap[data.emoji.name];
            if (roleRemove) {
                revokeRole(data.user_id, roleRemove)
                    .catch(err => console.error('删角色失败:', err.message));
            }
            break;
    }
};

// ===== 启动 =====
const start = async () => {
    console.log('🚀 启动机器人');
    connectWS();
};

start();
