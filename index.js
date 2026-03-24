require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

// 环境变量
const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const announceChannelId = process.env.ANNOUNCE_CHANNEL_ID;
const adminRoleId = process.env.ADMIN_ROLE_ID;

if (!token || !guildId || !pcRoleId || !consoleRoleId || !announceChannelId) {
    console.error('缺少必要的环境变量');
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

// ========== API 请求封装 ==========
const apiRequest = async (method, path, data = null) => {
    const url = `${API_BASE}${path}`;
    const headers = {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json'
    };
    try {
        const response = await axios({ method, url, data, headers });
        console.log(`API ${method} ${path} 成功`);
        return response.data;
    } catch (err) {
        console.error(`API 请求失败 (${method} ${path}):`, err.response?.data || err.message);
        throw err;
    }
};

// 发送文本消息
const sendMessage = async (channelId, content) => {
    const data = { channel_id: channelId, content, type: 1 };
    return await apiRequest('post', '/message/create', data);
};

// 发送卡片消息
const sendCardMessage = async (channelId, cardArray) => {
    const data = {
        channel_id: channelId,
        type: 10,
        content: JSON.stringify(cardArray)
    };
    return await apiRequest('post', '/message/create', data);
};

// 角色操作
const grantRole = async (userId, roleId) => {
    const data = { guild_id: guildId, user_id: userId, role_id: roleId };
    return await apiRequest('post', '/guild/grant-role', data);
};

const revokeRole = async (userId, roleId) => {
    const data = { guild_id: guildId, user_id: userId, role_id: roleId };
    return await apiRequest('post', '/guild/revoke-role', data);
};

// 获取频道消息列表
const getMessages = async (channelId, limit = 100) => {
    const url = `/message/list?channel_id=${channelId}&limit=${limit}`;
    const res = await apiRequest('get', url);
    return res.data?.items || [];
};

// 获取消息详情
const getMessage = async (msgId) => {
    const res = await apiRequest('get', `/message/view?msg_id=${msgId}`);
    return res.data;
};

// 获取服务器成员列表
const getGuildMembers = async (page = 1, pageSize = 200) => {
    const url = `/guild/user-list?guild_id=${guildId}&page=${page}&page_size=${pageSize}`;
    const res = await apiRequest('get', url);
    return res.data?.items || [];
};

// 获取用户信息
const getUserInfo = async (userId) => {
    const res = await apiRequest('get', `/user/view?user_id=${userId}`);
    return res.data;
};

// 检查管理员权限
const isAdmin = async (userId) => {
    try {
        if (adminRoleId) {
            const user = await getUserInfo(userId);
            return user.roles && user.roles.includes(adminRoleId);
        } else {
            const user = await getUserInfo(userId);
            return user.is_admin === true;
        }
    } catch (err) {
        console.error('检查管理员权限失败:', err);
        return false;
    }
};

// 查找已有卡片
const findExistingCard = async () => {
    try {
        const messages = await getMessages(announceChannelId, 100);
        for (const msg of messages) {
            if (msg.author.bot && msg.content.includes(CARD_MARKER)) {
                return msg;
            }
        }
    } catch (err) {
        console.error('查找已有卡片失败:', err);
    }
    return null;
};

// 发送角色卡片
const sendRoleCard = async () => {
    const card = {
        type: "card",
        theme: "info",
        modules: [
            {
                type: "section",
                text: {
                    type: "kmarkdown",
                    content: CARD_MARKER + "\n🖱️ PC平台\n🎮 主机平台"
                }
            },
            {
                type: "divider"
            }
        ]
    };
    const result = await sendCardMessage(announceChannelId, [card]);
    return result.data;
};

// 同步角色
const syncRoles = async () => {
    if (!cardMessageId) {
        console.log('未找到卡片消息，跳过同步');
        return;
    }
    console.log('开始同步角色...');
    let msg;
    try {
        msg = await getMessage(cardMessageId);
        if (!msg) {
            console.log('卡片消息不存在，跳过同步');
            return;
        }
    } catch (err) {
        console.error('获取卡片消息失败:', err);
        return;
    }

    const reactionUsersMap = {};
    for (const [emoji, roleId] of Object.entries(emojiRoleMap)) {
        const reaction = msg.reactions?.find(r => r.emoji.name === emoji);
        if (reaction && reaction.users) {
            reactionUsersMap[roleId] = new Set(reaction.users.map(u => u.id));
        } else {
            reactionUsersMap[roleId] = new Set();
        }
    }

    for (const [roleId, users] of Object.entries(reactionUsersMap)) {
        for (const userId of users) {
            await grantRole(userId, roleId).catch(err => console.error(`添加角色失败 (${userId}):`, err.message));
        }
    }

    let allMembers = [];
    let page = 1;
    while (true) {
        const members = await getGuildMembers(page, 200);
        if (!members || members.length === 0) break;
        allMembers.push(...members);
        if (members.length < 200) break;
        page++;
    }

    for (const member of allMembers) {
        const userId = member.id;
        for (const [emoji, roleId] of Object.entries(emojiRoleMap)) {
            if (member.roles.includes(roleId)) {
                if (!reactionUsersMap[roleId]?.has(userId)) {
                    await revokeRole(userId, roleId).catch(err => console.error(`移除角色失败 (${userId}):`, err.message));
                }
            }
        }
    }
    console.log('同步完成');
};

// ========== 网关连接 ==========
let wsGatewayUrl = null;

const getGatewayUrl = async () => {
    try {
        const res = await apiRequest('get', '/gateway/index');
        if (res.code === 0 && res.data.url) {
            return res.data.url;
        } else {
            throw new Error('获取网关地址失败: ' + JSON.stringify(res));
        }
    } catch (err) {
        console.error('获取网关地址失败:', err);
        throw err;
    }
};

const connectWebSocket = async () => {
    if (!wsGatewayUrl) {
        try {
            wsGatewayUrl = await getGatewayUrl();
            console.log('网关地址:', wsGatewayUrl);
        } catch (err) {
            console.error('无法获取网关地址，5秒后重试');
            setTimeout(connectWebSocket, 5000);
            return;
        }
    }

    ws = new WebSocket(wsGatewayUrl);

    ws.on('open', () => {
        console.log('WebSocket 已连接');
        const authPayload = {
            type: 'IDENTIFY',
            token: token,
            compress: false,
            intents: 1024 // 监听消息和反应
        };
        ws.send(JSON.stringify(authPayload));
        console.log('已发送 IDENTIFY 包');
    });

    ws.on('message', (data) => {
        const message = data.toString();
        let event;
        try {
            event = JSON.parse(message);
        } catch (err) {
            console.error('解析消息失败:', err, '原始消息:', message.substring(0, 200));
            return;
        }

        // 打印所有事件类型，方便调试
        console.log(`收到事件: ${event.type || 'unknown'}`);

        if (event.type === 'HEARTBEAT_ACK') {
            return;
        }

        if (event.type === 'HELLO') {
            const interval = event.data.heartbeat_interval;
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'PING' }));
                }
            }, interval);
            console.log('已设置心跳，间隔', interval);
            return;
        }

        if (event.type !== 'PONG') {
            handleGatewayEvent(event);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`WebSocket 关闭: ${code} ${reason}`);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        setTimeout(connectWebSocket, 5000);
    });

    ws.on('error', (err) => {
        console.error('WebSocket 错误:', err);
        ws.close();
    });
};

// ========== 事件处理 ==========
const handleGatewayEvent = (event) => {
    const { type, d } = event;
    console.log(`处理事件: ${type}`);

    switch (type) {
        case 'MESSAGE_CREATE':
            console.log('收到消息:', d.content);
            if (d.type !== 1) break; // 只处理文本消息
            if (d.content === '!sendcard') {
                console.log('收到 !sendcard 指令，来自用户:', d.author.id);
                (async () => {
                    const isAuth = await isAdmin(d.author.id);
                    if (!isAuth) {
                        console.log('用户无权限');
                        await sendMessage(d.channel_id, '你没有权限执行此指令。');
                        return;
                    }
                    try {
                        const newMsg = await sendRoleCard();
                        cardMessageId = newMsg.msg_id;
                        console.log('卡片已发送，ID:', cardMessageId);
                        await syncRoles();
                        await sendMessage(d.channel_id, '卡片已发送，并已同步角色状态。');
                    } catch (err) {
                        console.error('发送卡片失败:', err);
                        await sendMessage(d.channel_id, '发送卡片失败，请检查日志。');
                    }
                })();
            }
            break;

        case 'MESSAGE_REACTION_ADDED':
            console.log('添加反应:', d.emoji.name, '用户:', d.user_id);
            if (d.guild_id !== guildId) break;
            if (d.msg_id !== cardMessageId) break;
            if (d.user_id === '1') break;

            const roleAdd = emojiRoleMap[d.emoji.name];
            if (roleAdd) {
                grantRole(d.user_id, roleAdd).catch(err => console.error(`添加角色失败:`, err.message));
            }
            break;

        case 'MESSAGE_REACTION_REMOVED':
            console.log('移除反应:', d.emoji.name, '用户:', d.user_id);
            if (d.guild_id !== guildId) break;
            if (d.msg_id !== cardMessageId) break;
            if (d.user_id === '1') break;

            const roleRemove = emojiRoleMap[d.emoji.name];
            if (roleRemove) {
                revokeRole(d.user_id, roleRemove).catch(err => console.error(`移除角色失败:`, err.message));
            }
            break;

        default:
            console.log('未处理的事件类型:', type);
            break;
    }
};

// ========== 启动 ==========
const start = async () => {
    console.log('启动机器人...');
    const existing = await findExistingCard();
    if (existing) {
        cardMessageId = existing.msg_id;
        console.log(`找到已有卡片: ${cardMessageId}`);
        await syncRoles();
    } else {
        console.log('未找到已有卡片，请使用 !sendcard 指令发送。');
    }

    setInterval(async () => {
        console.log('执行定时同步...');
        await syncRoles();
    }, 24 * 60 * 60 * 1000);

    connectWebSocket();
};

start();
