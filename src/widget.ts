// ─────────────────────────────────────────────────────────────────────────────
//  LiveSupport — Embeddable Chat Widget  v2.0
//  Features:
//    • Proactive greeting after 5 s on first visit
//    • Periodic check-in ("still there?") when visitor is idle
//    • Advanced visual customisation (colours, radius, size, fonts, CSS)
//    • AI chatbot & bot indicator
//    • Human-handoff support
//    • Socket.IO real-time (typing, read, presence)
//    • Email collection gate (optional)
//    • Unread badge on launcher
//
//  Usage:
//    <script src="/widget.js"
//      data-widget-key="KEY"
//      data-api-url="http://localhost:4000"
//      async></script>
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  /* ── Config ─────────────────────────────────────────────────────────────── */
  const script      = document.currentScript as HTMLScriptElement | null;
  const WIDGET_KEY  = script?.dataset.widgetKey  ?? '';
  const API_URL     = (script?.dataset.apiUrl    ?? 'http://localhost:4000').replace(/\/$/, '');
  const WS_URL      = script?.dataset.wsUrl      ?? API_URL;

  if (!WIDGET_KEY) { console.warn('[LiveSupport] data-widget-key is required'); return; }

  /* ── State ──────────────────────────────────────────────────────────────── */
  let socket: any          = null;
  let settings: any        = {};
  let visitorId            = '';
  let convId               = '';
  let isOpen               = false;
  let emailCollected       = false;
  let unreadCount          = 0;
  let proactiveTimer: any  = null;
  let checkinTimer: any    = null;
  let checkinCount         = 0;
  let typingOutTimer: any  = null;
  let audioCtx: AudioContext | null = null;
  let pendingSound         = false;

  const LS_VID   = 'ls_vid_'   + WIDGET_KEY;
  const LS_CONV  = 'ls_conv_'  + WIDGET_KEY;
  const LS_EMAIL = 'ls_email_' + WIDGET_KEY;

  /* ── DOM refs ───────────────────────────────────────────────────────────── */
  let container:    HTMLDivElement;
  let launcher:     HTMLDivElement;
  let panel:        HTMLDivElement;
  let badgeEl:      HTMLDivElement;
  let messagesEl:   HTMLDivElement;
  let inputEl:      HTMLTextAreaElement;
  let sendBtn:      HTMLButtonElement;
  let typingEl:     HTMLDivElement;
  let headerStatus: HTMLSpanElement;

  /* ── Helpers ────────────────────────────────────────────────────────────── */
  function css(el: HTMLElement, s: Partial<CSSStyleDeclaration>) { Object.assign(el.style, s); }

  function make<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    styles: Partial<CSSStyleDeclaration> = {},
    attrs: Record<string,string> = {},
  ): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    css(e, styles);
    for (const [k,v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  function shade(hex: string, pct: number): string {
    const n = parseInt(hex.replace('#',''), 16);
    const a = Math.round(2.55 * pct);
    const r = Math.max(0, Math.min(255, (n >> 16) + a));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + a));
    const b = Math.max(0, Math.min(255, (n & 0xff) + a));
    return '#' + ((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
  }

  function hhmm() {
    return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  }

  /* ── API ────────────────────────────────────────────────────────────────── */
  async function api(path: string, body?: object) {
    const res = await fetch(API_URL + path, {
      method:  body ? 'POST' : 'GET',
      headers: { 'Content-Type':'application/json', 'x-widget-key': WIDGET_KEY },
      body:    body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  /* ── Boot ───────────────────────────────────────────────────────────────── */
  async function init() {
    try {
      const res = await api('/api/widget/init', {
        visitorFingerprint: navigator.userAgent + screen.width + screen.height,
        pageData: {
          url:      location.href,
          title:    document.title,
          referrer: document.referrer,
        },
        visitorData: {},
      });
      if (!res.success) return;

      settings  = res.data.widgetSettings ?? {};
      visitorId = localStorage.getItem(LS_VID) || res.data.visitorId;
      localStorage.setItem(LS_VID, visitorId);

      const savedConv = localStorage.getItem(LS_CONV);
      if (savedConv) convId = savedConv;
      emailCollected = !!localStorage.getItem(LS_EMAIL);

      buildUI();
      loadSocketIO();

      // ── Proactive greeting: open after 5 s on first load ────────────────
      const proactiveDelay = settings.proactiveDelaySeconds != null
        ? settings.proactiveDelaySeconds * 1000
        : 5000;
      if (settings.proactiveGreeting !== false) {
        proactiveTimer = setTimeout(() => {
          if (!isOpen) {
            openPanel(false); // silent open — just show the panel
            playNotificationSound();
            showBotMessage(
              settings.proactiveMessage ?? "Hi there! 👋 I'm here if you need any help.",
              false
            );
            scheduleCheckin();
          }
        }, proactiveDelay);
      }
    } catch (err) {
      console.error('[LiveSupport] init error:', err);
    }
  }

  /* ── Socket.IO ──────────────────────────────────────────────────────────── */
  function loadSocketIO() {
    if ((window as any).io) { connectSocket(); return; }
    const s = make('script', {}, { src: 'https://cdn.socket.io/4.7.4/socket.io.min.js' });
    s.onload = connectSocket;
    document.head.appendChild(s);
  }

  function connectSocket() {
    socket = (window as any).io(WS_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
      auth: { widgetKey: WIDGET_KEY },
    });

    socket.on('connect', () => {
      console.log('[LiveSupport] socket connected:', socket.id);
      if (convId) socket.emit('visitor:join', { conversationId: convId, visitorId });
    });

    socket.on('connect_error', (err: any) => {
      console.warn('[LiveSupport] socket error:', err.message);
    });

    socket.on('message:new', (msg: any) => {
      if (msg.conversationId !== convId) return;
      if (msg.senderType === 'VISITOR') return; // own message — skip
      const isBot   = msg.senderType === 'BOT';
      const isAgent = msg.senderType === 'AGENT';
      if (!isBot && !isAgent) return;
      setTyping(false);
      showBotMessage(msg.content, isBot);
      clearTimeout(checkinTimer);
      scheduleCheckin();
      if (!isOpen) {
        unreadCount++;
        updateBadge();
        playNotificationSound();
        showNotificationPulse(msg.content, isBot ? '🤖 Bot' : '💬 Agent');
      }
    });

    socket.on('agent:typing', ({ conversationId, isTyping: t }: any) => {
      if (conversationId === convId) setTyping(t);
    });

    socket.on('conversation:updated', (conv: any) => {
      if (conv.id !== convId) return;
      if (conv.botHandedOff || conv.status === 'ASSIGNED') {
        headerStatus.textContent = '● Connected with agent';
        css(headerStatus, { color: '#86efac' });
      }
    });

    socket.on('conversation:resolved', (conv: any) => {
      const resolvedId = conv.conversationId || conv.id;
      if (resolvedId !== convId) return;
      handleConversationResolved();
    });
  }

  /* ── Periodic check-in ──────────────────────────────────────────────────── */
  function scheduleCheckin() {
    if (settings.periodicCheckin === false) return;
    const delay = (settings.checkinIntervalSeconds ?? 90) * 1000;
    clearTimeout(checkinTimer);
    checkinTimer = setTimeout(doCheckin, delay);
  }

  function doCheckin() {
    if (checkinCount >= (settings.maxCheckins ?? 3)) return;
    const msgs = [
      settings.checkinMessage ?? "Still there? 😊 Let us know if you need anything.",
      "Just checking in — did you find what you were looking for?",
      "We're still here if you have any questions!",
    ];
    const msg = msgs[checkinCount % msgs.length];
    showBotMessage(msg, false);
    playNotificationSound();
    if (!isOpen) {
      unreadCount++;
      updateBadge();
      showNotificationPulse(msg, '💬 Support');
    }
    checkinCount++;
    scheduleCheckin();
  }

  /* ── Build UI ───────────────────────────────────────────────────────────── */
  function buildUI() {
    const primary  = settings.primaryColor   ?? '#2563eb';
    const textClr  = settings.textColor      ?? '#ffffff';
    const chatBg   = settings.chatBg         ?? '#f8fafc';
    const widgetBg = settings.widgetBg       ?? '#ffffff';
    const radius   = settings.borderRadius   ?? '18px';
    const width    = settings.width          ?? '360px';
    const height   = settings.height         ?? '520px';
    const font     = settings.fontFamily     ?? 'Inter, system-ui, sans-serif';
    const pos      = settings.launcherPosition ?? 'bottom-right';
    const isRight  = pos !== 'bottom-left';
    const shadow   = settings.shadow ?? '0 20px 60px rgba(0,0,0,0.15)';

    // Font import
    if (!document.getElementById('ls-font')) {
      const lnk = make('link', {}, { id:'ls-font', rel:'stylesheet', href:'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap' });
      document.head.appendChild(lnk);
    }

    // Keyframes
    if (!document.getElementById('ls-styles')) {
      const st = make('style', {}, { id:'ls-styles' });
      st.textContent = `
        @keyframes lsUp   { from { opacity:0; transform:translateY(10px) scale(.97) } to { opacity:1; transform:none } }
        @keyframes lsPop  { from { opacity:0; transform:scale(.85) } to { opacity:1; transform:scale(1) } }
        @keyframes lsDot  { 0%,80%,100% { transform:scale(.7); opacity:.4 } 40% { transform:scale(1); opacity:1 } }
        .ls-up  { animation: lsUp  .22s ease }
        .ls-pop { animation: lsPop .18s ease }
        .ls-dot { display:inline-block; width:5px; height:5px; border-radius:50%; background:#94a3b8; animation:lsDot 1.4s infinite }
        .ls-dot:nth-child(2){ animation-delay:.2s }
        .ls-dot:nth-child(3){ animation-delay:.4s }
        #ls-input:focus { outline:none }
        #ls-input { scrollbar-width:none }
        #ls-send:hover { filter:brightness(1.1) }
        #ls-send:disabled { opacity:.4; cursor:not-allowed }
        ${settings.customCss ?? ''}
      `;
      document.head.appendChild(st);
    }

    /* Container */
    container = make('div', {
      position:'fixed', bottom:'20px', zIndex:'2147483647',
      [isRight ? 'right' : 'left']: '20px',
      fontFamily: font, fontSize:'14px',
      display:'flex', flexDirection:'column',
      alignItems: isRight ? 'flex-end' : 'flex-start',
    });

    /* ── Panel ─────────────────────────────────────────────────────────── */
    panel = make('div', {
      width, height, borderRadius: radius,
      background: widgetBg,
      boxShadow: shadow,
      border:'1px solid rgba(0,0,0,0.07)',
      display:'none', flexDirection:'column',
      overflow:'hidden', marginBottom:'12px',
    });
    panel.className = 'ls-up';

    /* Header */
    const header = make('div', {
      padding:'14px 16px', display:'flex', alignItems:'center', gap:'10px',
      background: `linear-gradient(135deg, ${primary}, ${shade(primary, -18)})`,
      flexShrink:'0',
    });

    const hLeft = make('div', { display:'flex', alignItems:'center', gap:'10px', flex:'1', minWidth:'0' });

    // Agent / bot avatar
    const av = make('div', {
      width:'36px', height:'36px', borderRadius:'50%',
      background:'rgba(255,255,255,0.2)', border:'2px solid rgba(255,255,255,0.4)',
      display:'flex', alignItems:'center', justifyContent:'center',
      fontSize:'15px', fontWeight:'700', color: textClr, flexShrink:'0',
    });
    av.textContent = settings.agentAvatar ?? (settings.brandName?.[0]?.toUpperCase() ?? 'S');

    const hText = make('div', { flex:'1', minWidth:'0' });
    const hName = make('div', { fontWeight:'700', fontSize:'14px', color:textClr, lineHeight:'1.2' });
    hName.textContent = settings.brandName ?? 'Support';

    const hSub = make('div', { display:'flex', alignItems:'center', gap:'5px', marginTop:'3px' });
    const hDot = make('div', { width:'6px', height:'6px', borderRadius:'50%', background:'#4ade80', flexShrink:'0' });
    headerStatus = make('span', { fontSize:'11.5px', color:'rgba(255,255,255,0.82)', fontWeight:'500' });
    headerStatus.textContent = settings.statusText ?? 'Online · Replies instantly';
    hSub.append(hDot, headerStatus);
    hText.append(hName, hSub);
    hLeft.append(av, hText);

    const closeBtn = make('button', {
      background:'rgba(255,255,255,0.15)', border:'none', cursor:'pointer',
      borderRadius:'8px', padding:'7px', display:'flex', alignItems:'center', justifyContent:'center',
      transition:'background .15s', flexShrink:'0',
    });
    closeBtn.innerHTML = svgX(textClr);
    closeBtn.onmouseenter = () => css(closeBtn, { background:'rgba(255,255,255,0.28)' });
    closeBtn.onmouseleave = () => css(closeBtn, { background:'rgba(255,255,255,0.15)' });
    closeBtn.onclick = closePanel;
    header.append(hLeft, closeBtn);

    /* Messages */
    messagesEl = make('div', {
      flex:'1', overflowY:'auto', padding:'14px 14px 6px',
      display:'flex', flexDirection:'column', gap:'10px',
      background: chatBg,
    });

    /* Typing indicator */
    typingEl = make('div', { display:'none', padding:'0 14px 6px', background:chatBg });
    const typBubble = make('div', { display:'inline-flex', gap:'3px', alignItems:'center', padding:'8px 12px', background:'white', borderRadius:'14px 14px 14px 4px', border:'1px solid #e2e8f0', boxShadow:'0 1px 4px rgba(0,0,0,0.05)' });
    typBubble.innerHTML = '<span class="ls-dot"></span><span class="ls-dot"></span><span class="ls-dot"></span>';
    typingEl.appendChild(typBubble);

    /* Email gate */
    let emailGate: HTMLDivElement | null = null;
    if (settings.collectEmailBeforeChat && !emailCollected) {
      emailGate = buildEmailGate(primary, textClr);
    }

    /* Input area */
    const inputArea = make('div', { padding:'10px 12px 10px', borderTop:'1px solid #e2e8f0', background:'white', flexShrink:'0' });

    const inputRow = make('div', { display:'flex', gap:'8px', alignItems:'flex-end' });
    inputEl = make('textarea', {
      flex:'1', resize:'none', border:'1px solid #e2e8f0', borderRadius:'10px',
      padding:'9px 12px', fontSize:'13.5px', lineHeight:'1.4', maxHeight:'100px',
      fontFamily: font, background:'#f8fafc', color:'#0f172a', transition:'border-color .15s',
    }, { id:'ls-input', rows:'1', placeholder: settings.inputPlaceholder ?? 'Type a message…' });

    inputEl.addEventListener('focus',  () => css(inputEl, { borderColor:primary, background:'white', boxShadow:`0 0 0 3px ${primary}22` }));
    inputEl.addEventListener('blur',   () => css(inputEl, { borderColor:'#e2e8f0', background:'#f8fafc', boxShadow:'none' }));
    inputEl.addEventListener('input',  autoResize);
    inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
      else emitTyping();
    });

    sendBtn = make('button', {
      width:'38px', height:'38px', borderRadius:'10px',
      background: `linear-gradient(135deg, ${primary}, ${shade(primary,-15)})`,
      border:'none', cursor:'pointer', display:'flex', alignItems:'center',
      justifyContent:'center', flexShrink:'0', transition:'filter .15s',
      boxShadow:`0 2px 8px ${primary}44`,
    }, { id:'ls-send' });
    sendBtn.innerHTML = svgSend();
    sendBtn.onclick = handleSend;
    inputRow.append(inputEl, sendBtn);

    const powered = make('div', { textAlign:'center', marginTop:'6px', fontSize:'10.5px', color:'#cbd5e1' });
    if (!settings.removeBranding) {
      powered.textContent = 'Powered by LiveSupport';
    }
    inputArea.append(inputRow, powered);

    /* Assemble */
    panel.append(header, messagesEl, typingEl);
    if (emailGate) panel.appendChild(emailGate);
    panel.appendChild(inputArea);

    /* ── Launcher ──────────────────────────────────────────────────────── */
    launcher = make('div', {
      width:'58px', height:'58px', borderRadius:'50%',
      background:`linear-gradient(135deg, ${primary}, ${shade(primary,-20)})`,
      boxShadow:`0 4px 20px ${primary}55`,
      display:'flex', alignItems:'center', justifyContent:'center',
      cursor:'pointer', transition:'transform .2s, box-shadow .2s',
      userSelect:'none', position:'relative', flexShrink:'0',
    });
    launcher.innerHTML = svgChat(textClr);
    launcher.onmouseenter = () => css(launcher, { transform:'scale(1.08)', boxShadow:`0 6px 28px ${primary}77` });
    launcher.onmouseleave = () => css(launcher, { transform:'scale(1)',    boxShadow:`0 4px 20px ${primary}55` });
    launcher.onclick = togglePanel;

    /* Unread badge */
    badgeEl = make('div', {
      position:'absolute', top:'-4px', right:'-4px', width:'20px', height:'20px',
      borderRadius:'50%', background:'#ef4444', color:'white', fontSize:'11px',
      fontWeight:'700', display:'none', alignItems:'center', justifyContent:'center',
      border:'2px solid white', boxShadow:'0 2px 6px rgba(239,68,68,.5)',
    });
    launcher.appendChild(badgeEl);

    container.append(panel, launcher);
    document.body.appendChild(container);

    // Show welcome message
    showWelcome();
  }

  /* ── Welcome ────────────────────────────────────────────────────────────── */
  function showWelcome() {
    const msg = settings.greetingMessage ?? 'Hi there 👋 How can we help you today?';
    showBotMessage(msg, false, false);
  }

  /* ── Email gate ─────────────────────────────────────────────────────────── */
  function buildEmailGate(primary: string, textClr: string): HTMLDivElement {
    const gate = make('div', { padding:'16px', background:'white', borderTop:'1px solid #e2e8f0', flexShrink:'0' });
    const title = make('div', { fontSize:'13.5px', fontWeight:'700', color:'#0f172a', marginBottom:'4px' });
    title.textContent = settings.emailFormTitle ?? 'What is your email?';
    const sub = make('div', { fontSize:'12px', color:'#94a3b8', marginBottom:'12px', lineHeight:'1.5' });
    sub.textContent = settings.emailFormSubtitle ?? "We'll reply to your email if you're not around.";
    const inp = make('input', { width:'100%', border:'1px solid #e2e8f0', borderRadius:'10px', padding:'9px 12px', fontSize:'13.5px', fontFamily:'inherit', marginBottom:'10px', outline:'none', transition:'border-color .15s', boxSizing:'border-box' }, { type:'email', placeholder:'you@example.com' });
    inp.addEventListener('focus', () => css(inp, { borderColor:primary }));
    inp.addEventListener('blur',  () => css(inp, { borderColor:'#e2e8f0' }));
    const btn = make('button', { width:'100%', padding:'10px', borderRadius:'10px', background:`linear-gradient(135deg,${primary},${shade(primary,-15)})`, color:textClr, border:'none', fontWeight:'700', fontSize:'13.5px', cursor:'pointer', fontFamily:'inherit' });
    btn.textContent = 'Start chatting →';
    btn.onclick = () => {
      const email = inp.value.trim();
      if (!/\S+@\S+\.\S+/.test(email)) { css(inp, { borderColor:'#ef4444' }); return; }
      localStorage.setItem(LS_EMAIL, email);
      emailCollected = true;
      panel.removeChild(gate);
      initConversation(email);
    };
    gate.append(title, sub, inp, btn);
    return gate;
  }

  /* ── Append message ─────────────────────────────────────────────────────── */
  function showBotMessage(text: string, isBot: boolean, animate = true) {
    const primary = settings.primaryColor ?? '#2563eb';
    const wrap = make('div', { display:'flex', flexDirection:'column', alignItems:'flex-start', gap:'3px' });
    if (animate) wrap.className = 'ls-up';

    const row = make('div', { display:'flex', gap:'7px', alignItems:'flex-end' });

    const avEl = make('div', { width:'26px', height:'26px', borderRadius:'50%', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', fontSize:isBot ? '13px' : '11px', fontWeight:'700', background: isBot ? '#f5f3ff' : '#ecfdf5', border: isBot ? '1px solid #ddd6fe' : '1px solid #a7f3d0' });
    avEl.textContent = isBot ? '🤖' : settings.agentAvatar ?? '💬';

    const bubble = make('div', { maxWidth:'78%', padding:'9px 13px', borderRadius:'14px 14px 14px 4px', fontSize:'13.5px', lineHeight:'1.55', wordBreak:'break-word', whiteSpace:'pre-wrap', background:'white', color:'#0f172a', border:'1px solid #e2e8f0', boxShadow:'0 1px 4px rgba(0,0,0,.05)' });
    if (isBot) {
      const lbl = make('div', { fontSize:'10px', color:'#7c3aed', fontWeight:'700', marginBottom:'4px' });
      lbl.textContent = '⚡ AI Bot';
      bubble.appendChild(lbl);
    }
    const txt = make('span');
    txt.textContent = text;
    bubble.appendChild(txt);

    const ts = make('div', { fontSize:'10.5px', color:'#94a3b8', marginTop:'1px', paddingLeft:'33px' });
    ts.textContent = hhmm();

    row.append(avEl, bubble);
    wrap.append(row, ts);
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  function showVisitorMessage(text: string) {
    const primary   = settings.primaryColor ?? '#2563eb';
    const textClr   = settings.textColor    ?? '#ffffff';
    const wrap = make('div', { display:'flex', flexDirection:'column', alignItems:'flex-end', gap:'3px' });
    wrap.className = 'ls-up';
    const bubble = make('div', { maxWidth:'78%', padding:'9px 13px', borderRadius:'14px 14px 4px 14px', fontSize:'13.5px', lineHeight:'1.55', wordBreak:'break-word', whiteSpace:'pre-wrap', background:`linear-gradient(135deg,${primary},${shade(primary,-15)})`, color:textClr, boxShadow:`0 2px 8px ${primary}44` });
    bubble.textContent = text;
    const ts = make('div', { fontSize:'10.5px', color:'#94a3b8', marginTop:'1px', textAlign:'right' });
    ts.textContent = hhmm();
    wrap.append(bubble, ts);
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  /* ── Typing ─────────────────────────────────────────────────────────────── */
  function setTyping(show: boolean) {
    css(typingEl, { display: show ? 'block' : 'none' });
    if (show) scrollBottom();
  }

  function emitTyping() {
    if (!socket || !convId) return;
    socket.emit('visitor:typing', { conversationId: convId, isTyping: true });
    clearTimeout(typingOutTimer);
    typingOutTimer = setTimeout(() =>
      socket.emit('visitor:typing', { conversationId: convId, isTyping: false }), 2000);
  }

  /* ── Conversation resolved ──────────────────────────────────────────────── */
  function handleConversationResolved() {
    // Update header to show resolved state
    headerStatus.textContent = '● Chat ended';
    css(headerStatus, { color: '#fca5a5' });

    // Disable input and send button
    inputEl.disabled = true;
    sendBtn.disabled = true;
    css(inputEl, { opacity: '0.5', cursor: 'not-allowed', background: '#f1f5f9' });
    css(sendBtn, { opacity: '0.3', cursor: 'not-allowed' });
    inputEl.placeholder = 'This chat has ended.';

    // Clear stored conversation so next open starts fresh
    localStorage.removeItem(LS_CONV);
    convId = '';

    // Show a system message in the chat
    const chatBg = settings.chatBg ?? '#f8fafc';
    const wrap = make('div', { display: 'flex', justifyContent: 'center', padding: '6px 0' });
    const pill = make('div', {
      fontSize: '11.5px', color: '#64748b', background: '#f1f5f9',
      border: '1px solid #e2e8f0', borderRadius: '20px', padding: '5px 14px',
      textAlign: 'center', lineHeight: '1.4',
    });
    pill.textContent = '✓ This chat has been resolved by the agent.';

    const newChatBtn = make('button', {
      marginTop: '8px', padding: '8px 18px', borderRadius: '8px', border: 'none',
      background: settings.primaryColor ?? '#2563eb', color: settings.textColor ?? '#ffffff',
      fontSize: '12px', fontWeight: '600', cursor: 'pointer', display: 'block', width: '100%',
    });
    newChatBtn.textContent = 'Start a new chat';
    newChatBtn.onclick = () => {
      // Re-enable the input and start fresh
      inputEl.disabled = false;
      sendBtn.disabled = false;
      css(inputEl, { opacity: '1', cursor: 'text', background: '#f8fafc' });
      css(sendBtn, { opacity: '1', cursor: 'pointer' });
      inputEl.placeholder = settings.inputPlaceholder ?? 'Type a message…';
      headerStatus.textContent = settings.statusText ?? 'Online · Replies instantly';
      css(headerStatus, { color: 'rgba(255,255,255,0.82)' });
      // Clear chat messages and show welcome
      messagesEl.innerHTML = '';
      showWelcome();
      inputEl.focus();
    };

    wrap.appendChild(pill);
    messagesEl.appendChild(wrap);
    messagesEl.appendChild(newChatBtn);
    scrollBottom();

    // If panel is closed, show a notification pulse
    if (!isOpen) {
      showNotificationPulse('This chat has been resolved. Start a new chat if you need help.', '✓ Support');
    }
  }

  /* ── Send ───────────────────────────────────────────────────────────────── */
  async function handleSend() {
    const text = inputEl.value.trim();
    if (!text || sendBtn.disabled) return;
    inputEl.value = '';
    css(inputEl, { height:'auto' });
    sendBtn.disabled = true;
    showVisitorMessage(text);

    if (!convId) await initConversation();

    try {
      const result = await api(`/api/widget/conversations/${convId}/messages`, { content: text });
      if (!result.success && result.error?.code === 'CONVERSATION_RESOLVED') {
        // Race condition: resolved between last render and this send
        handleConversationResolved();
        sendBtn.disabled = false;
        return;
      }
      setTyping(true);
    } catch (err) {
      console.error('[LiveSupport] send error:', err);
      setTyping(false);
    }

    sendBtn.disabled = false;
    clearTimeout(checkinTimer);
    scheduleCheckin();
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
  }

  /* ── Conversation init ──────────────────────────────────────────────────── */
  async function initConversation(email?: string) {
    if (convId) return;
    try {
      const res = await api('/api/widget/conversations', {
        visitorId, email, currentUrl: location.href,
      });
      if (!res.success) return;
      convId = res.data.conversationId;
      localStorage.setItem(LS_CONV, convId);
      if (socket) socket.emit('visitor:join', { conversationId: convId });
    } catch (err) {
      console.error('[LiveSupport] conv init error:', err);
    }
  }

  /* ── Panel toggle ───────────────────────────────────────────────────────── */
  function openPanel(focusInput = true) {
    if (isOpen) return;
    clearTimeout(proactiveTimer);
    isOpen = true;
    css(panel, { display:'flex' });
    panel.className = 'ls-up';
    launcher.innerHTML = svgX(settings.textColor ?? '#ffffff');
    unreadCount = 0; updateBadge();
    scrollBottom();
    if (focusInput) setTimeout(() => inputEl?.focus(), 80);
    if (!convId && !settings.collectEmailBeforeChat) initConversation();
  }

  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    css(panel, { display:'none' });
    launcher.innerHTML = svgChat(settings.textColor ?? '#ffffff');
  }

  function togglePanel() { isOpen ? closePanel() : openPanel(); }

  /* ── Badge ──────────────────────────────────────────────────────────────── */
  function updateBadge() {
    if (unreadCount > 0) {
      badgeEl.textContent = String(Math.min(unreadCount, 9)) + (unreadCount > 9 ? '+' : '');
      css(badgeEl, { display:'flex' });
    } else {
      css(badgeEl, { display:'none' });
    }
  }

  function scrollBottom() {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }


  /* ── Notification sound (Web Audio API — no external file needed) ─────── */
  function playNotificationSound() {
    try {
      if (!ensureAudioContext()) return;

      const play = () => {
        const ctx = audioCtx!;
        const startAt = ctx.currentTime + 0.01;
        // Two-tone "ding" — pleasant, not jarring
        [880, 1100].forEach((freq, i) => {
          const at   = startAt + i * 0.12;
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, at + 0.35);
          osc.start(at);
          osc.stop(at + 0.36);
        });
      };

      if (audioCtx.state === 'suspended') {
        pendingSound = true;
        audioCtx.resume().then(() => {
          if (pendingSound) {
            pendingSound = false;
            play();
          }
        }).catch(() => {
          pendingSound = true;
        });
      } else {
        pendingSound = false;
        play();
      }
    } catch {
      pendingSound = true;
    }
  }

  function ensureAudioContext() {
    const AudioCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtor) return false;
    audioCtx = audioCtx || new AudioCtor();
    return true;
  }

  function primeNotificationSound() {
    if (!ensureAudioContext()) return;
    audioCtx!.resume().then(() => {
      if (pendingSound) playNotificationSound();
    }).catch(() => {
      pendingSound = true;
    });
  }

  ['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => {
    window.addEventListener(eventName, primeNotificationSound, { passive: true });
  });

  /* ── Notification pulse bubble above launcher ────────────────────────── */
  let notifEl: HTMLDivElement | null = null;
  let notifTimer: any = null;

  function showNotificationPulse(msgText: string, senderLabel: string) {
    clearTimeout(notifTimer);

    // Remove old one
    if (notifEl && notifEl.parentNode) notifEl.parentNode.removeChild(notifEl);

    const primary   = settings.primaryColor ?? '#2563eb';
    const pos       = settings.launcherPosition ?? 'bottom-right';
    const isRight   = pos !== 'bottom-left';
    const maxChars  = 72;
    const preview   = msgText.length > maxChars ? msgText.slice(0, maxChars) + '…' : msgText;

    notifEl = make('div', {
      position:    'fixed',
      bottom:      '90px',
      [isRight ? 'right' : 'left']: '20px',
      maxWidth:    '280px',
      background:  'white',
      borderRadius: '14px',
      padding:     '12px 14px',
      boxShadow:   '0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)',
      border:      '1px solid #e2e8f0',
      zIndex:      '2147483647',
      cursor:      'pointer',
      animation:   'lsUp 0.25s ease',
      fontFamily:  settings.fontFamily ?? 'Inter, system-ui, sans-serif',
    });

    const senderRow = make('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' });
    const dot       = make('div', { width: '8px', height: '8px', borderRadius: '50%', background: primary, flexShrink: '0' });
    const sender    = make('span', { fontSize: '11px', fontWeight: '700', color: primary });
    sender.textContent = senderLabel;
    senderRow.append(dot, sender);

    const msgEl = make('div', { fontSize: '13px', color: '#0f172a', lineHeight: '1.45' });
    msgEl.textContent = preview;

    // Dismiss X
    const xBtn = make('button', {
      position: 'absolute', top: '8px', right: '10px',
      background: 'none', border: 'none', cursor: 'pointer',
      color: '#94a3b8', fontSize: '16px', lineHeight: '1', padding: '0',
    });
    xBtn.textContent = '×';
    xBtn.onclick = (e) => {
      e.stopPropagation();
      dismissNotif();
    };

    notifEl.style.position = 'fixed';
    notifEl.append(senderRow, msgEl, xBtn);
    notifEl.onclick = () => { openPanel(); dismissNotif(); };
    document.body.appendChild(notifEl);

    // Auto-dismiss after 6 s
    notifTimer = setTimeout(dismissNotif, 6000);
  }

  function dismissNotif() {
    clearTimeout(notifTimer);
    if (notifEl) {
      css(notifEl, { opacity: '0', transition: 'opacity .25s' });
      setTimeout(() => { if (notifEl?.parentNode) notifEl.parentNode.removeChild(notifEl); notifEl = null; }, 300);
    }
  }

  /* ── SVG icons ──────────────────────────────────────────────────────────── */
  function svgChat(c: string) {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  }
  function svgX(c: string) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  }
  function svgSend() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  }

  /* ── Boot ───────────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
