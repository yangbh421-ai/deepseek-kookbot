require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

// 环境变量
const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const announceChannelId = process.env.ANNOUNCE_CHANNEL_ID;
const adminRoleId = process.env.ADMIN_ROLE_ID; // 可选

// 检查必要变量
if (!token || !guildId || !pcRoleId || !consoleRoleId || !announceChannelId) {
    console.error('缺少必要的环境变量：KOOK_TOKEN, GUILD_ID, PC_ROLE_ID, CONSOLE_ROLE_ID, ANNOUNCE_CHANNEL_ID');
    process.exit(1);
}

const API_BASE = 'https://www.kookapp.cn/api/v3';
const CARD_MARKER = '【角色自助分配卡片】请点击下方表情获取对应角色：';
let cardMessageId = null;      // 当前卡片消息ID
let ws = null;
let heartbeatInterval = null;
let sequence = null;            // 网关事件序号

// 表情 → 角色映射
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
        return response.data;
    } catch (err) {
        console.error(`API 请求失败 (${method} ${path}):`, err.response?.data || err.message);
        throw err;
    }
};

// 发送消息（文本或卡片）
const sendMessage = async (channelId, content, type = 1) => {
    const data = { channel_id: channelId, content, type };
    return await apiRequest('post', '/message/create', data);
};

// 发送卡片消息
const sendCardMessage = async (channelId, cardArray) => {
    const data = {
        channel_id: channelId,
        type: 10,
        content: JSON.stringify(cardArray) // 必须转为 JSON 字符串
    };
    return await apiRequest('post', '/message/create', data);
};

// 给用户添加角色
const grantRole = async (userId, roleId) => {
    const data = { guild_id: guildId, user_id: userId, role_id: roleId };
    return await apiRequest('post', '/guild/grant-role', data);
};

// 移除用户角色
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

// 获取单条消息详情（含 reactions）
const getMessage = async (msgId) => {
    const res = await apiRequest('get', `/message/view?msg_id=${msgId}`);
    return res.data;
};

// 获取服务器成员列表（分页）
const getGuildMembers = async (page = 1, pageSize = 200) => {
    const url = `/guild/user-list?guild_id=${guildId}&page=${page}&page_size=${pageSize}`;
    const res = await apiRequest('get', url);
    return res.data?.items || [];
};

// 获取用户信息（用于检查管理员权限）
const getUserInfo = async (userId) => {
    const res = await apiRequest('get', `/user/view?user_id=${userId}`);
    return res.data;
};

// ========== 辅助函数 ==========
// 检查用户是否有执行指令的权限
const isAdmin = async (userId) => {
    try {
        if (adminRoleId) {
            const member = await getUserInfo(userId);
            return member.roles && member.roles.includes(adminRoleId);
        } else {
            const user = await getUserInfo(userId);
            return user.is_admin === true;
        }
    } catch (err) {
        console.error('检查管理员权限失败:', err);
        return false;
    }
};

// 查找已有的卡片消息（由本机器人发送的）
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
    try {
        const result = await sendCardMessage(announceChannelId, [card]);
        return result.data;
    } catch (err) {
        console.error('发送卡片失败:', err);
        throw err;
    }
};

// 同步角色：确保卡片上的反应与用户角色一致
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

    // 提取各表情的反应用户
    const reactionUsersMap = {};
    for (const [emoji, roleId] of Object.entries(emojiRoleMap)) {
        const reaction = msg.reactions?.find(r => r.emoji.name === emoji);
        if (reaction && reaction.users) {
            reactionUsersMap[roleId] = new Set(reaction.users.map(u => u.id));
        } else {
            reactionUsersMap[roleId] = new Set();
        }
    }

    // 为有反应的用户添加角色（如果尚未拥有）
    for (const [roleId, users] of Object.entries(reactionUsersMap)) {
        for (const userId of users) {
            await grantRole(userId, roleId).catch(err => console.error(`添加角色失败 (${userId}):`, err.message));
        }
    }

    // 获取服务器中拥有这两个角色的所有用户，移除没有反应的用户角色
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

// 获取网关地址
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
        // 发送认证包
        const authPayload = {
            type: 'IDENTIFY',
            token: token,
            compress: false,
            intents: 1024 // 监听消息和反应事件
        };
        ws.send(JSON.stringify(authPayload));
    });

    ws.on('message', (data) => {
        const message = data.toString();
        let event;
        try {
            event = JSON.parse(message);
        } catch (err) {
            console.error('解析消息失败:', err);
            return;
        }

        // 处理心跳响应
        if (event.type === 'HEARTBEAT_ACK') {
            return;
        }

        // 如果是 HELLO 事件，建立心跳
        if (event.type === 'HELLO') {
            const interval = event.data.heartbeat_interval;
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'PING' }));
                }
            }, interval);
            return;
        }

        // 处理业务事件
        if (event.type !== 'PONG') {
            handleGatewayEvent(event);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`WebSocket 关闭: ${code} ${reason}`);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        // 5秒后重连
        setTimeout(connectWebSocket, 5000);
    });

    ws.on('error', (err) => {
        console.error('WebSocket 错误:', err);
        ws.close(); // 触发重连
    });
};

// ========== 网关消息处理 ==========
const handleGatewayEvent = (event) => {
    const { type, d } = event;
    if (event.s) sequence = event.s;

    switch (type) {
        case 'MESSAGE_CREATE':
            // 处理普通消息（指令）
            if (d.type !== 1) break; // 只处理文本消息
            if (d.content === '!sendcard') {
                (async () => {
                    const isAuth = await isAdmin(d.author.id);
                    if (!isAuth) {
                        await sendMessage(d.channel_id, '你没有权限执行此指令。');
                        return;
                    }
                    try {
                        const newMsg = await sendRoleCard();
                        cardMessageId = newMsg.msg_id;
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
            if (d.guild_id !== guildId) break;
            if (d.msg_id !== cardMessageId) break;
            if (d.user_id === '1') break; // 忽略机器人自己

            const emojiAdd = d.emoji.name;
            const roleIdAdd = emojiRoleMap[emojiAdd];
            if (roleIdAdd) {
                grantRole(d.user_id, roleIdAdd).catch(err => console.error(`添加角色失败 (${d.user_id}):`, err.message));
            }
            break;

        case 'MESSAGE_REACTION_REMOVED':
            if (d.guild_id !== guildId) break;
            if (d.msg_id !== cardMessageId) break;
            if (d.user_id === '1') break;

            const emojiRemove = d.emoji.name;
            const roleIdRemove = emojiRoleMap[emojiRemove];
            if (roleIdRemove) {
                revokeRole(d.user_id, roleIdRemove).catch(err => console.error(`移除角色失败 (${d.user_id}):`, err.message));
            }
            break;

        default:
            // 其他事件忽略
            break;
    }
};

// ========== 启动机器人 ==========
const start = async () => {
    console.log('启动机器人...');

    // 先查找已有卡片
    const existing = await findExistingCard();
    if (existing) {
        cardMessageId = existing.msg_id;
        console.log(`找到已有卡片: ${cardMessageId}`);
        await syncRoles();
    } else {
        console.log('未找到已有卡片，请使用 !sendcard 指令发送。');
    }

    // 启动定时同步（每24小时）
    setInterval(async () => {
        console.log('执行定时同步...');
        await syncRoles();
    }, 24 * 60 * 60 * 1000);

    // 连接网关
    connectWebSocket();
};

start();
