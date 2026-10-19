/* ==========================================================
 * znt.js —— 时空终端 v1.0 交互逻辑
 * 模块划分：
 *   1) 背景星空渲染
 *   2) 智能体配置（AGENTS）
 *   3) 视图切换
 *   4) 智能体卡片渲染与切换
 *   5) 消息渲染 / 发送 / 模拟回复
 *   6) 真实 API 接入预留位（见 fetchReply 内 TODO）
 * ========================================================== */

'use strict';

/* ==========================================================
 * 1) 背景：轻量星空 + 偶发流星
 * ========================================================== */
const Starfield = (() => {
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [];
  let shooting = null;
  let dpr = window.devicePixelRatio || 1;

  function resize() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    build();
  }

  function build() {
    const count = Math.min(160, Math.floor((window.innerWidth * window.innerHeight) / 9000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: (Math.random() * 1.4 + 0.3) * dpr,
      a: Math.random() * 0.6 + 0.25,
      v: (Math.random() * 0.15 + 0.02) * (Math.random() > 0.5 ? 1 : -1) // 闪烁速度
    }));
  }

  function drawShootingStar() {
    if (!shooting) {
      // 随机生成一颗流星
      if (Math.random() > 0.996) {
        shooting = {
          x: Math.random() * canvas.width * 0.7,
          y: Math.random() * canvas.height * 0.4,
          len: 120 * dpr,
          life: 1
        };
      }
      return;
    }
    const g = ctx.createLinearGradient(shooting.x, shooting.y,
      shooting.x + shooting.len, shooting.y + shooting.len * 0.55);
    g.addColorStop(0, `rgba(34,211,238,${0.55 * shooting.life})`);
    g.addColorStop(1, 'rgba(168,85,247,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    ctx.moveTo(shooting.x, shooting.y);
    ctx.lineTo(shooting.x + shooting.len, shooting.y + shooting.len * 0.55);
    ctx.stroke();

    shooting.x += 6 * dpr;
    shooting.y += 3.3 * dpr;
    shooting.life -= 0.018;
    if (shooting.life <= 0) shooting = null;
  }

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const s of stars) {
      s.a += 0.012 * s.v;
      if (s.a > 1 || s.a < 0.15) s.v *= -1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(190,215,255,${Math.abs(s.a)})`;
      ctx.fill();
    }

    drawShootingStar();
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  resize();
  loop();

  // 尊重「减少动态效果」的系统偏好
  return { stop: () => { stars = []; shooting = null; } };
})();


/* ==========================================================
 * 2) 扣子（Coze）智能体接入配置
 *    —— 只需填 3 个值：令牌 + 两个智能体的 bot_id，页面即真实对话
 *    —— 任意一项为空时自动回退到本地模拟，不影响页面运行
 *
 *    令牌获取：扣子控制台 → 扣子 API → 授权 → 个人访问令牌
 *             需勾选 chat 权限（生成后只显示一次，注意保存）
 *    bot_id 获取：打开智能体编辑页，地址栏 .../bot/73428668xxxx 里的那串数字
 *
 *    ⚠️ 安全提醒：令牌写在前端代码里，任何打开此页面的人按 F12 都能看到。
 *       自己做demo/课程作业没问题；对外发布务必改成后端代理转发。
 * ========================================================== */
const COZE_CONFIG = {
  enabled: true,          // 改成 false 可强制使用本地模拟
  token: 'pat_TFZ7YmYKrtFrRzBxbvhg4ULMkKc7hWjmQOjO1muK6pdjeO4KrKs0GljyibavZYld',   // 形如 'pat_xxxxxxxxxxxxxxxx'
  apiBase: 'https://api.coze.cn',

  // 智能体 ID 映射：键名对应下面 AGENTS 里的 id
  bots: {
    wastelander: '7698292915872727049',      // 废土生存专家
    sheriff: '7698296361578053695'           // 时空警长
  },

  // 会话用户标识：同一浏览器保持一致，扣子据此隔离记忆
  userId: (() => {
    try {
      let uid = localStorage.getItem('mvs_uid');
      if (!uid) {
        uid = 'mvs-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('mvs_uid', uid);
      }
      return uid;
    } catch {
      return 'mvs-anonymous';   // 隐私模式下 localStorage 可能不可用
    }
  })()
};

/**
 * 扣子 API 客户端
 * 使用 /v3/chat 的流式（SSE）模式：回复边生成边显示，体验接近真实终端
 * 文档：https://www.coze.cn/open/docs/developer_guides/chat_v3
 */
const Coze = {
  // agentId -> conversation_id，用于同一智能体的多轮上下文
  conversationIds: {},

  /** 该智能体是否已经配置好可以走真实接口 */
  isReady(agentId) {
    return COZE_CONFIG.enabled
      && /^pat_/.test(COZE_CONFIG.token || '')
      && !!COZE_CONFIG.bots[agentId];
  },

  /** 切换智能体 / 重置会话时，丢弃服务端会话，保证开场白是全新的 */
  resetConversation(agentId) {
    delete this.conversationIds[agentId];
  },

  /**
   * 发起一次对话
   * @param {string} agentId
   * @param {string} userText
   * @param {{onDelta?: (full:string)=>void, signal?: AbortSignal}} opts
   * @returns {Promise<string>} 完整回复文本
   */
  async chat(agentId, userText, { onDelta, signal } = {}) {
    const botId = COZE_CONFIG.bots[agentId];
    const convId = this.conversationIds[agentId];
    const url = COZE_CONFIG.apiBase + '/v3/chat' + (convId ? `?conversation_id=${encodeURIComponent(convId)}` : '');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COZE_CONFIG.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: COZE_CONFIG.userId,
        stream: true,                 // 流式返回
        auto_save_history: true,      // 由扣子侧保存上下文
        additional_messages: [
          { role: 'user', content: userText, content_type: 'text' }
        ]
      }),
      signal
    });

    // 失败时尽量把扣子返回的 msg 透出来，方便排查令牌/发布状态问题
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        if (err && (err.msg || err.error_message)) detail += ` · ${err.msg || err.error_message}`;
      } catch { /* 响应体不是 JSON 就忽略 */ }
      throw new Error(detail);
    }

    // ⚠️ 扣子的错误经常是「HTTP 200 + JSON 错误体」（如令牌无效返回 code 4101），
    //    所以不能用状态码判断，必须看 content-type 是否为事件流
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      let msg = '接口未返回事件流';
      try {
        const body = await res.json();
        if (body?.msg) msg = `[${body.code ?? '-'}] ${body.msg}`;
        else if (body?.error_message) msg = body.error_message;
      } catch { /* 非 JSON 就保留默认提示 */ }
      throw new Error(msg);
    }

    if (!res.body) throw new Error('当前浏览器不支持流式读取');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let answer = '';
    let reasoning = '';
    let failure = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件；一次 read 可能带来多个事件，需循环切分
      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const { event, data } = this.parseEvent(raw);

        // 记录会话 ID，后续多轮对话带上它
        if (event === 'conversation.chat.created' && data?.conversation_id) {
          this.conversationIds[agentId] = data.conversation_id;
        }

        if (event === 'conversation.message.delta' && data?.type === 'answer') {
          // 普通智能体：content 是正文增量（打字机效果）
          if (data.content) {
            answer += data.content;
            onDelta && onDelta(answer, '');
          }
          // 开启「深度思考」的智能体：正文迟迟不给，先把推理过程吐在 reasoning_content 里
          else if (data.reasoning_content) {
            reasoning += data.reasoning_content;
            onDelta && onDelta('', reasoning);
          }
        }

        // 深度思考型智能体往往只在 completed 里给完整正文
        if (event === 'conversation.message.completed' && data?.type === 'answer' && data?.content) {
          if (data.content.length > answer.length) {
            answer = data.content;
            onDelta && onDelta(answer, '');
          }
        }

        // 错误事件：流里报错不会让 HTTP 状态码变成 4xx
        if (event === 'conversation.chat.failed' || event === 'error') {
          failure = data?.last_error?.msg || data?.msg || '对话执行失败';
        }
      }
    }

    if (failure) throw new Error(failure);
    if (!answer.trim()) throw new Error('智能体没有返回任何内容');
    return answer;
  },

  /** 解析单个 SSE 事件块 */
  parseEvent(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join('\n');
    if (!dataStr || dataStr === '[DONE]') return { event, data: null };
    try {
      return { event, data: JSON.parse(dataStr) };
    } catch {
      return { event, data: null };
    }
  }
};


/* ==========================================================
 * 3) 智能体配置
 *    —— 新增智能体只需往这个数组里加一项，UI 会自动生成卡片
 * ========================================================== */
const AGENTS = [
  {
    id: 'wastelander',
    name: '废土生存专家',
    tag: 'WASTELAND SURVIVAL',
    desc: '擅长极端环境求生',
    icon: 'fa-skull-crossbones',
    color: '#a3e635',
    // 专属开场白
    greeting: '滴——生命体征正常。幸存者，在这片废土上，你最大的依仗就是我。今天想了解如何在辐射区找水，还是对付变异的变异鼠？',
    // 快捷提问
    chips: ['辐射区怎么找干净的水？', '遇到变异鼠怎么办？', '夜里该在哪里过夜？', '哪些东西绝对不能吃？'],
    // 关键词 -> 定向回复（命中优先于随机池）
    keywordReplies: [
      { keys: ['水', '喝', '渴', '净水'], reply: '找水的第一条规矩：流动的水比静止的干净，地下的比地面的干净。用衣服包住沙子过滤三次，再煮沸三分钟。实在没有火，就把水装在浅盘里晒六个小时——紫外线是免费的消毒剂。' },
      { keys: ['鼠', '老鼠', '变异鼠', '怪物'], reply: '变异鼠重四十公斤，但髋关节是弱点，它会直线冲刺，不会急转弯。背靠墙，让它先冲，横向闪开，一棍子砸在它的后腿根。别用枪——声音会招来比它更大的东西。' },
      { keys: ['吃', '食物', '饿', '罐头'], reply: '三条铁律：不认识的菌类一律不吃；粉色肉类一律不吃；过期五年以上的罐头闻着没味也一律不吃（肉毒杆菌是没有味道的）。宁可饿两天，也别赌一口。' },
      { keys: ['辐射', '防化', '盖革'], reply: '辐射看不见闻不着，但它怕三样东西：距离、屏蔽和时间。退到十米外，躲在混凝土后，等二十四个小时，地表剂量会衰减大半。脱外套时往内卷，别抖。' }
    ],
    // 随机回复池（硬核与搞笑混搭）
    replies: [
      '我在这片废土上活了二十七年。你知道我是怎么做到的吗？我从不跟比自己更绝望的东西讲道理。',
      '你的靴子在渗水。赶紧脱下来检查一下——脚一旦泡烂，你连走到下一个避难所的机会都没有。',
      '忘掉净水片吧，那玩意儿早过期了。把水煮沸，然后对着它骂两句。这不杀菌，但能让你心态好一点。',
      '实测数据：在辐射尘暴里，蒙住口鼻能让你多活四十七分钟。够你找到一个还算完整的冰箱——可以当避难舱。',
      ' Variant-7 型变异鼠会装死。要确认它死了，先用长杆戳三下，间隔十分钟。它会以为你走了。',
      '别相信任何带 Logo 的食品。上次我按包装上的保质期吃了一块能量棒，结果在沙子里躺了三天，做了很多奇怪的梦。',
      '如果夜里听到有人喊你的名字——不要回答。废土上会模仿人声的东西，一共有十九种，它们全都很饿。',
      '记住方位：太阳落下那边通常有水源，但它也可能是个巨大的坑。这两件事在废土上都不算新鲜。',
      '给你个硬数据：人在没有水的条件下平均活三天，但恐慌能把这个数字压到六小时。所以首先——冷静，然后找水。',
      '我背包里永远有三样东西：一小段铁丝、一块打火石、还有一张家人照片。前两样救命，第三样让你知道为什么值得活。'
    ]
  },
  {
    id: 'sheriff',
    name: '时空警长',
    tag: 'TIME PATROL UNIT',
    desc: '擅长时间悖论解答',
    icon: 'fa-shield-halved',
    color: '#22d3ee',
    greeting: '警告！检测到时间线扰动！我是时空警长。别试图用祖父悖论骗我，告诉我，你是从哪条时间线掉进来的？',
    chips: ['我遇到了祖父悖论', '如何回到自己的时间线？', '我见到了另一个我', '时间线编号说明'],
    keywordReplies: [
      { keys: ['祖父', '悖论', '爷爷'], reply: '祖父悖论在实务上并不成立。你回到过去杀掉祖父的那一刻，你的出生概率归零，而「归零」意味着执行「杀」这个动作的主体也不存在——逻辑自动回滚。所以你最多造成一次擦伤，或者成就一段你祖母不太想提起的往事。' },
      { keys: ['回去', '回到', '回家', '返回'], reply: '要回原时间线，我需要你的出发时间戳和因果锚点。先把你口袋里的东西掏出来——任何来自你原本时代的物件都可以充当锚点，包括那张过期的公交卡。' },
      { keys: ['怎么办', '怎么搞', '求助'], reply: '标准处置流程三步走：第一，不要与任何版本的自己发生肢体接触；第二，不要改变任何你记得的历史事件；第三，不要告诉过去的任何人今天的日期。做到这三点，你的时间线保住八成。' }
    ],
    replies: [
      '根据《跨时间线管制条例》第七条：禁止向过去的自己透露彩票号码、股票点位和球赛比分。违者处以时间线内终身回溯。',
      '你刚才那句话，在三条不同的时间线里同时构成了因果闭环。恭喜，你现在既是自己的父亲，也是自己的祖母。这事儿我见过十一次，没有一次是干净的。',
      '别紧张。比起上一批掉进来的那家伙——他为了证明自己能穿越，回去把自己的闹钟提前了五分钟——你目前的违规程度还只是「口头违纪」。',
      '提醒一下：你现在所处的时间线编号为 M-1024，属于稳定区。这意味着你的任何改动都会被自动修正，但修正过程会把你身体里的每个原子重排一遍。会有点晕。',
      '我处理过一个案子：某位幸存者为了救一只猫改变了整个城市的供电走向。现在那条时间线上所有人都在点蜡烛，而那只猫，成了网红。',
      '如果你看到天空同时出现两个月亮，请不要拍照，请立刻躺下。那说明至少有两条时间线正在你头顶合并，站着的话会比较吃亏。',
      '我这生涯里抓过最离谱的家伙，他复制了十七个自己开派对。我们花了三个世纪才把十七个人重新合并回去——中间有一次合并反了。',
      '想耍我？省省吧。我比对过你谈话时的时态一致性——你在第三人称和第一人称之间切换过四次，典型的跨线后遗症。先喝点水，我们慢慢来。',
      '时间不是河流，是一条被熨过无数次的领带。你现在站在其中一个折痕里，而我负责把你烫平——或者烫回原形。',
      '统计显示：在未经许可的时间跳跃中，有 73% 的人第一句话是问「现在是几几年」。你是少数先关心价格的，有意思。'
    ]
  }
];

/* 兜底回复：两侧通用 */
const FALLBACK_REPLIES = [
  '信号受到量子干扰，这句没听清。麻烦再讲一遍——用更短的句子，最好别带隐喻。',
  '数据库里没有这条记录。按照协议，我应当保持沉默；但按照直觉，我建议你先找个能遮住头顶的地方。',
  '这个问题跨越了十七个专业领域，我只能回答其中最要命的那部分：先活下来，然后再问我一次。'
];


/* ==========================================================
 * 3) 主应用
 * ========================================================== */
const App = {
  currentView: 'home',
  currentAgent: AGENTS[0],       // 默认选中【废土生存专家】
  history: {},                   // agentId -> 消息数组（切换智能体时保留各自的会话）
  typingEl: null,
  usedPool: {},                  // agentId -> 已用过的随机回复索引，避免连续重复

  /* ---------------- 视图切换 ---------------- */
  switchView(view, opts) {
    this.currentView = view;

    // 移动端进入终端页时锁定视口高度（见 znt.css 的 body.view-lock）
    document.body.classList.toggle('view-lock', view === 'terminal');

    // 同步 URL hash（形如 index.html#terminal），方便直接分享/刷新定位
    if (!opts || !opts.silent) {
      if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    }

    // 显示/隐藏三个视图
    ['home', 'terminal', 'guide'].forEach(v => {
      const el = document.getElementById('view-' + v);
      if (!el) return;
      el.classList.toggle('hidden', v !== view);
      if (v !== view) return;
      // 重置入场动画：先移除类名、强制重排，再重新添加
      el.classList.remove('view-enter');
      void el.offsetWidth;
      el.classList.add('view-enter');
    });

    // 更新 Tab 高亮
    document.querySelectorAll('.tab-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    // 进入终端时聚焦输入框，并把聊天区滚动到底部
    if (view === 'terminal') {
      this.renderQuickChips();
      this.scrollToBottom();
      // 仅桌面端自动聚焦：移动端自动弹软键盘会挡住半个屏幕
      if (window.matchMedia('(min-width: 1024px)').matches) {
        setTimeout(() => document.getElementById('chatInput')?.focus({ preventScroll: true }), 350);
      }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  /* ---------------- 渲染智能体卡片（侧边栏） ---------------- */
  renderAgentCards() {
    const box = document.getElementById('agentList');
    // 同一份数据渲染两种密度：窄屏是紧凑小卡，桌面是完整信息卡
    box.innerHTML = AGENTS.map(a => `
      <article class="agent-card rounded-xl p-3 lg:p-3.5 ${a.id === this.currentAgent.id ? 'active' : ''}"
               style="--card-color:${a.color}"
               data-agent="${a.id}"
               onclick="App.selectAgent('${a.id}')">
        <div class="flex items-center gap-2.5 lg:items-start lg:gap-3">
          <span class="w-8 h-8 lg:w-10 lg:h-10 shrink-0 rounded-lg grid place-items-center text-sm lg:text-lg"
                style="background:${a.color}1f; color:${a.color}; box-shadow:0 0 0 1px ${a.color}55 inset;">
            <i class="fa-solid ${a.icon}"></i>
          </span>
          <div class="min-w-0 flex-1">
            <h3 class="font-semibold text-white text-[12.5px] lg:text-sm truncate">${a.name}</h3>
            <p class="hidden lg:block text-[10px] tracking-wider mt-0.5" style="color:${a.color}">${a.tag}</p>
            <p class="hidden lg:block text-[11px] text-[#8ea0c9] mt-1 leading-snug">${a.desc}</p>
            <p class="lg:hidden mt-0.5 flex items-center gap-1 text-[10px] text-[#4ade80]">
              <span class="status-dot" style="width:6px;height:6px"></span>在线
            </p>
          </div>
        </div>
        <div class="hidden lg:flex mt-2.5 items-center justify-between text-[10px]">
          <span class="flex items-center gap-1 text-[#4ade80]"><span class="status-dot"></span>在线</span>
          <span class="text-[#5f6f99]" data-count-msg="${a.id}">${(this.history[a.id] || []).length} 条对话</span>
        </div>
      </article>
    `).join('');
  },

  /* ---------------- 选择智能体：清空对话 + 发送专属开场白 ---------------- */
  selectAgent(id) {
    const agent = AGENTS.find(a => a.id === id);
    if (!agent) return;

    this.currentAgent = agent;

    // 卡片选中态
    document.querySelectorAll('.agent-card').forEach(c => {
      c.classList.toggle('active', c.dataset.agent === id);
    });

    // 更新聊天头部信息（标注当前内核：扣子 API / 本地模拟）
    const ava = document.getElementById('chatAvatar');
    ava.innerHTML = `<i class="fa-solid ${agent.icon}"></i>`;
    ava.style.setProperty('--agent-color', agent.color);
    ava.style.background = agent.color + '1f';
    ava.style.color = agent.color;
    document.getElementById('chatName').textContent = agent.name;
    const mode = Coze.isReady(agent.id) ? '扣子智能体' : '本地模拟';
    const descEl = document.getElementById('chatDesc');
    descEl.textContent = `在线 · ${mode} · ${agent.desc}`;
    descEl.title = descEl.textContent;

    this.renderQuickChips();

    // 换人即视为新会话：丢弃扣子侧上下文，保证开场白是全新的
    Coze.resetConversation(id);

    // 清空聊天区并重新播放该智能体的开场白
    document.getElementById('chatBody').innerHTML = '';
    this.history[id] = [];
    this.updateMsgCounters();
    // 稍作停顿再播放开场白，让"连接建立"的感觉更真实
    setTimeout(() => this.pushMessage('ai', agent.greeting), 220);
  },

  /* ---------------- 快捷提问标签 ---------------- */
  renderQuickChips() {
    const box = document.getElementById('quickChips');
    box.innerHTML = this.currentAgent.chips.map(q =>
      `<button type="button" class="chip text-[11px] sm:text-xs px-3 py-1.5 rounded-full" onclick="App.useChip(this)">${this.escapeHtml(q)}</button>`
    ).join('');
  },

  useChip(btn) {
    const input = document.getElementById('chatInput');
    input.value = btn.textContent.trim();
    input.focus({ preventScroll: true });
    this.autoGrow(input);
  },

  /* ---------------- 发送主流程 ---------------- */
  sendMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    // 清空输入并复位高度
    input.value = '';
    this.autoGrow(input);

    this.pushMessage('user', text);
    this.respondTo(text);
  },

  handleEnter(e) {
    // Enter 发送，Shift + Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessage();
    }
  },

  autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  },

  /* ---------------- 生成 AI 回复 ---------------- */
  async respondTo(userText) {
    const agentId = this.currentAgent.id;

    // ① 未配置令牌 / bot_id：走本地模拟内核
    if (!Coze.isReady(agentId)) {
      this.showTyping();
      await new Promise(r => setTimeout(r, 1000));
      this.hideTyping();
      this.pushMessage('ai', this.mockReply(agentId, userText));
      return;
    }

    // ② 已接入扣子：流式渲染（边生成边显示）
    const bubble = this.createStreamBubble();
    try {
      const content = await Coze.chat(agentId, userText, {
        onDelta: (full, reasoning) => bubble.update(full, reasoning)
      });
      bubble.commit(content);
    } catch (err) {
      console.error('[时空终端] 扣子接口调用失败：', err);
      bubble.fail(err.message || '网络异常');
    }
  },

  /**
   * 创建一条"正在生成"的 AI 气泡，返回三个控制方法
   * 流式场景下不断 update，结束后 commit 写入历史
   */
  createStreamBubble() {
    const agent = this.currentAgent;
    const self = this;

    const wrap = document.createElement('div');
    wrap.className = 'msg-bubble flex gap-3';
    wrap.innerHTML = `
      <span class="w-9 h-9 shrink-0 rounded-xl grid place-items-center"
            style="background:${agent.color}1f; color:${agent.color}; box-shadow:0 0 0 1px ${agent.color}55 inset;">
        <i class="fa-solid ${agent.icon}"></i>
      </span>
      <div class="max-w-[78%]">
        <div class="bubble-ai rounded-2xl px-4 py-2.5 text-sm leading-relaxed" data-content>
          <div class="typing"><span></span><span></span><span></span></div>
        </div>
        <div class="mt-1 text-[10px] text-[#5f6f99] pl-1 hidden" data-meta></div>
      </div>`;

    document.getElementById('chatBody').appendChild(wrap);
    this.scrollToBottom();

    const contentEl = wrap.querySelector('[data-content]');
    const metaEl = wrap.querySelector('[data-meta]');
    let lastText = '';
    let lastReasoning = '';
    const startedAt = Date.now();

    const api = {
      // text：正式正文；reasoning：深度思考型智能体的推理过程
      update(text, reasoning) {
        if (reasoning !== undefined) lastReasoning = reasoning;

        if (text) {
          lastText = text;
          contentEl.innerHTML = self.formatText(text) + '<span class="caret"></span>';
        } else if (lastReasoning) {
          // 正文还没到时，把推理过程末尾滚动出来，并显示已等待时长
          const secs = Math.floor((Date.now() - startedAt) / 1000);
          const tail = lastReasoning.length > 80 ? '…' + lastReasoning.slice(-80) : lastReasoning;
          contentEl.innerHTML =
            `<span class="text-[11px] italic text-[#8ea0c9]" title="该智能体开启了深度思考，通常需要 30-60 秒">` +
            `深度思考中 · ${secs}s · ${self.escapeHtml(tail)}</span><span class="caret"></span>`;
        }
        self.scrollToBottom();
      },
      commit(finalText) {
        clearInterval(ticker);
        const text = finalText || lastText;
        contentEl.innerHTML = self.formatText(text);
        metaEl.classList.remove('hidden');
        metaEl.textContent = `${agent.name} · ${self.now()}`;
        (self.history[agent.id] ||= []).push({ role: 'ai', text, time: self.now() });
        self.updateMsgCounters();
        self.scrollToBottom();
      },
      fail(msg) {
        clearInterval(ticker);
        contentEl.innerHTML = `<span class="text-[#f87171]"><i class="fa-solid fa-triangle-exclamation mr-1.5"></i>${self.escapeHtml(msg)}</span>
          <div class="mt-2 text-[11px] leading-relaxed text-[#8ea0c9]">
            排查顺序：① 令牌是否有效且开通了 <span class="text-[#22d3ee]">chat</span> 权限；
            ② bot_id 是否正确；③ 该智能体是否已发布到 <span class="text-[#22d3ee]">Agent as API</span> 渠道。
            也可以把 <span class="text-[#22d3ee]">znt.js</span> 顶部的 <span class="text-[#22d3ee]">enabled</span> 改成 false 回到本地模拟。
          </div>`;
        metaEl.classList.remove('hidden');
        metaEl.textContent = `连接失败 · ${self.now()}`;
        self.scrollToBottom();
      }
    };

    // 模型思考时流可能是静默的，用定时器刷新秒数，让用户知道没有卡死
    const ticker = setInterval(() => {
      if (!lastText && lastReasoning) api.update('', lastReasoning);
    }, 800);

    return api;
  },

  /** 轻量格式化：先转义再处理 **粗体** / `代码` / 换行，避免 XSS */
  formatText(str) {
    let html = this.escapeHtml(str);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-white">$1</strong>');
    html = html.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-black/50 text-[#22d3ee] text-[0.9em]">$1</code>');
    html = html.replace(/\n/g, '<br>');
    return html;
  },

  /** 本地模拟回复：关键词命中优先，否则从随机池中抽取 */
  mockReply(agentId, text) {
    const agent = AGENTS.find(a => a.id === agentId) || this.currentAgent;
    const clean = text.toLowerCase();

    // 1) 关键词定向回复
    const hit = (agent.keywordReplies || []).find(k => k.keys.some(key => clean.includes(key)));
    if (hit) return hit.reply;

    // 2) 随机池：打乱后循环取用，保证连续多条不重复
    if (!this.usedPool[agentId]) this.usedPool[agentId] = [];
    const pool = this.usedPool[agentId];
    if (pool.length === 0) {
      // 一轮抽完则重新洗牌
      pool.push(...agent.replies.map((_, i) => i).sort(() => Math.random() - 0.5));
    }
    const idx = pool.shift();

    // 3) 极短输入做一次兜底，避免答非所问显得突兀
    if (clean.length <= 2 && Math.random() < 0.5) {
      return this.randomOf(FALLBACK_REPLIES);
    }
    return agent.replies[idx] || this.randomOf(FALLBACK_REPLIES);
  },

  randomOf(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  },

  /* ---------------- 消息渲染 ---------------- */
  pushMessage(role, text) {
    const id = this.currentAgent.id;
    if (!this.history[id]) this.history[id] = [];
    this.history[id].push({ role, text, time: this.now() });

    const body = document.getElementById('chatBody');
    body.appendChild(this.buildBubble(role, text));
    this.scrollToBottom();
    this.updateMsgCounters();
  },

  buildBubble(role, text) {
    const agent = this.currentAgent;
    const wrap = document.createElement('div');
    wrap.className = 'msg-bubble flex gap-3 ' + (role === 'user' ? 'flex-row-reverse' : '');

    const time = this.now();

    if (role === 'user') {
      wrap.innerHTML = `
        <span class="w-9 h-9 shrink-0 rounded-xl grid place-items-center bg-[#a855f7]/15 text-[#c084fc] border border-[#a855f7]/40">
          <i class="fa-solid fa-user-astronaut"></i>
        </span>
        <div class="max-w-[78%]">
          <div class="bubble-user rounded-2xl px-4 py-2.5 text-sm leading-relaxed">${this.escapeHtml(text)}</div>
          <div class="mt-1 text-[10px] text-[#5f6f99] text-right pr-1">幸存者 · ${time}</div>
        </div>`;
    } else {
      wrap.innerHTML = `
        <span class="w-9 h-9 shrink-0 rounded-xl grid place-items-center"
              style="background:${agent.color}1f; color:${agent.color}; box-shadow:0 0 0 1px ${agent.color}55 inset;">
          <i class="fa-solid ${agent.icon}"></i>
        </span>
        <div class="max-w-[78%]">
          <div class="bubble-ai rounded-2xl px-4 py-2.5 text-sm leading-relaxed">${this.formatText(text)}</div>
          <div class="mt-1 text-[10px] text-[#5f6f99] pl-1">${agent.name} · ${time}</div>
        </div>`;
    }

    // 文本已由 formatText 做过转义 + 轻量 Markdown 处理（粗体/行内代码/换行）
    return wrap;
  },

  /* ---------------- 正在输入指示器 ---------------- */
  showTyping() {
    const agent = this.currentAgent;
    const body = document.getElementById('chatBody');
    const el = document.createElement('div');
    el.id = 'typingIndicator';
    el.className = 'flex gap-3';
    el.innerHTML = `
      <span class="w-9 h-9 shrink-0 rounded-xl grid place-items-center"
            style="background:${agent.color}1f; color:${agent.color}; box-shadow:0 0 0 1px ${agent.color}55 inset;">
        <i class="fa-solid ${agent.icon}"></i>
      </span>
      <div class="bubble-ai rounded-2xl px-4 py-3">
        <div class="typing"><span></span><span></span><span></span></div>
      </div>`;
    body.appendChild(el);
    this.scrollToBottom();
  },

  hideTyping() {
    document.getElementById('typingIndicator')?.remove();
  },

  /* ---------------- 重置当前会话 ---------------- */
  resetConversation() {
    const agent = this.currentAgent;
    this.history[agent.id] = [];
    Coze.resetConversation(agent.id);   // 丢弃扣子侧的会话上下文
    document.getElementById('chatBody').innerHTML = '';
    setTimeout(() => this.pushMessage('ai', agent.greeting), 180);
  },

  /* ---------------- 工具函数 ---------------- */
  scrollToBottom() {
    const body = document.getElementById('chatBody');
    if (body) body.scrollTop = body.scrollHeight;
  },

  updateMsgCounters() {
    AGENTS.forEach(a => {
      const el = document.querySelector(`[data-count-msg="${a.id}"]`);
      if (el) el.textContent = `${(this.history[a.id] || []).length} 条对话`;
    });
  },

  now() {
    return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  },

  escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  },

  /* ---------------- 侧栏内核状态 ---------------- */
  updateKernelMode() {
    const el = document.getElementById('kernelMode');
    if (!el) return;
    const ready = AGENTS.filter(a => Coze.isReady(a.id)).length;
    if (ready === AGENTS.length) {
      el.textContent = '扣子 API';
      el.className = 'text-[#4ade80]';
    } else if (ready > 0) {
      el.textContent = `扣子 ${ready}/${AGENTS.length}`;
      el.className = 'text-[#fbbf24]';
    } else {
      el.textContent = '本地模拟';
      el.className = 'text-[#fbbf24]';
    }
    el.title = ready === 0
      ? '未配置扣子令牌或 bot_id，当前使用本地模拟回复'
      : `${ready} 个智能体已接入扣子 API`;

    // 输入框下方的说明跟随内核切换
    const hint = document.getElementById('kernelHint');
    if (hint) {
      hint.textContent = ready > 0 ? '已接入扣子智能体，回复由 AI 实时生成' : '模拟内核，回复随机生成，仅供娱乐';
    }
  },

  /* ---------------- 初始化 ---------------- */
  init() {
    this.renderAgentCards();
    this.updateKernelMode();
    this.selectAgent(this.currentAgent.id);   // 触发默认智能体的开场白

    // 默认落在首页；若 URL 带了 hash（如 #terminal），则直达对应视图
    const initial = (location.hash || '').replace('#', '');
    this.switchView(['home', 'terminal', 'guide'].includes(initial) ? initial : 'home');

    // 浏览器前进/后退时同步视图
    window.addEventListener('hashchange', () => {
      const v = (location.hash || '').replace('#', '');
      if (['home', 'terminal', 'guide'].includes(v) && v !== this.currentView) {
        this.switchView(v, { silent: true });
      }
    });

    // 首屏数字滚动动画
    document.querySelectorAll('[data-count]').forEach(el => {
      const target = parseInt(el.dataset.count, 10);
      const duration = 1200;
      const start = performance.now();
      const tick = now => {
        const p = Math.min((now - start) / duration, 1);
        el.textContent = Math.floor(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // 页脚装饰计数
    document.getElementById('footerTimeline').textContent = Math.floor(Math.random() * 900 + 100).toLocaleString();

    // 若 Tailwind CDN 未能加载（如离线），给出提示而不是白屏
    setTimeout(() => {
      if (typeof window.tailwind === 'undefined') {
        console.warn('[时空终端] Tailwind CDN 未加载，已退化为自定义基础样式，请把 index.html 置于联网环境或改用本地构建版 Tailwind。');
      }
    }, 1500);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
