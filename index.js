const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

const CFG = functions.config();
const AI_KEY = CFG.ai?.key || '';
const AI_PROVIDER = CFG.ai?.provider || 'groq';
const AI_MODEL = CFG.ai?.model || 'openai/gpt-oss-120b';
const TG_TOKEN = CFG.telegram?.token || '';

/* ============ مساعد داخلي ============ */
async function callAI(messages, opts = {}) {
  if (!AI_KEY) throw new Error('AI_KEY غير مضبوط');
  if (AI_PROVIDER === 'gemini') {
    const model = opts.model || (AI_MODEL.startsWith('gemini') ? AI_MODEL : 'gemini-1.5-flash');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${AI_KEY}`;
    const contents = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }]
    }));
    const sys = messages.find(m => m.role === 'system');
    const body = {
      contents,
      systemInstruction: sys ? { parts: [{ text: sys.content }] } : undefined,
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxTokens ?? 1500
      }
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'فشل Gemini');
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  const url = AI_PROVIDER === 'groq'
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const model = AI_PROVIDER === 'openai' ? (opts.model || 'gpt-4o-mini') : (opts.model || AI_MODEL);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_KEY}` },
    body: JSON.stringify({
      model, messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1500
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'فشل AI');
  return data.choices[0].message.content || '';
}

/* ============ 1. AI Chat عام ============ */
exports.aiChat = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول');
  }
  try {
    const messages = data.messages || [];
    const text = await callAI(messages);
    return { text };
  } catch (e) {
    throw new functions.https.HttpsError('internal', e.message);
  }
});

/* ============ 2. اقتراح رد ============ */
exports.aiSuggest = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول');
  }
  try {
    const history = data.history || [];
    const name = data.name || 'العميل';
    const convo = history.slice(-8).map(m =>
      (m.direction === 'in' ? 'العميل: ' : 'أنا: ') + (m.text || '')
    ).join('\n');
    const messages = [
      { role: 'system', content: 'أنت وكيل خدمة عملاء محترف في شركة عربية. اكتب ردًا قصيرًا وودّيًا بالعربية الفصحى المبسطة. لا تتجاوز 3 أسطر.' },
      { role: 'user', content: `اسم العميل: ${name}\n\nالمحادثة:\n${convo}\n\nاكتب الرد المناسب:` }
    ];
    const reply = await callAI(messages, { temperature: 0.8, maxTokens: 300 });
    return { reply };
  } catch (e) {
    throw new functions.https.HttpsError('internal', e.message);
  }
});

/* ============ 3. توليد محتوى ============ */
exports.aiContent = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول');
  }
  try {
    const { topic, platform, tone } = data;
    const platName = { facebook: 'فيسبوك', instagram: 'إنستجرام', twitter: 'تويتر/X', linkedin: 'لينكدإن', telegram: 'تيليجرام' }[platform] || platform;
    const toneName = { professional: 'احترافي', friendly: 'ودّي', funny: 'فكاهي', inspiring: 'ملهم' }[tone] || tone;
    const messages = [
      { role: 'system', content: `كاتب محتوى خبير. اكتب منشور ${platName} بنبرة ${toneName}. ${platform === 'twitter' ? 'لا تتجاوز 280 حرفًا.' : ''} أضف هاشتاجات مناسبة. أعد النص فقط.` },
      { role: 'user', content: `الموضوع: ${topic}` }
    ];
    const text = await callAI(messages, { temperature: 0.8, maxTokens: 800 });
    return { text };
  } catch (e) {
    throw new functions.https.HttpsError('internal', e.message);
  }
});

/* ============ 4. رد آلي على رسالة ============ */
exports.autoReply = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول');
  }
  try {
    const { text, platform, customerName } = data;
    const messages = [
      { role: 'system', content: 'أنت وكيل دعم ذكي. رد بإيجاز وودّية بالعربية. إذا سأل عن الأسعار قل أن فريق المبيعات سيتواصل قريبًا. إذا كانت شكوى قل أن المدير سيتابع فورًا.' },
      { role: 'user', content: text }
    ];
    const reply = await callAI(messages, { temperature: 0.7, maxTokens: 300 });

    // حفظ الرد الآلي إن أردت
    if (data.conversationId) {
      const convRef = db.collection('conversations').doc(data.conversationId);
      const convDoc = await convRef.get();
      if (convDoc.exists && convDoc.data().ownerId === context.auth.uid) {
        await convRef.collection('messages').add({
          direction: 'out',
          text: reply,
          ai: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await convRef.update({ updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
    return { reply };
  } catch (e) {
    throw new functions.https.HttpsError('internal', e.message);
  }
});

/* ============ 5. Telegram Webhook ============ */
exports.telegramWebhook = functions.https.onRequest(async (req, res) => {
  res.sendStatus(200);
  try {
    if (!TG_TOKEN) return;
    const msg = req.body?.message;
    if (!msg?.text) return;

    const chatId = String(msg.chat.id);
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'مستخدم';
    const convId = 'tg_' + chatId;

    // نبحث عن المحادثة (بدون ownerId لأن webhook لا يعرف المستخدم)
    // الحل: كل محادثة تُنشأ من الواجهة، أو نستخدم admin token
    const convRef = db.collection('conversations').doc(convId);
    const convDoc = await convRef.get();

    if (!convDoc.exists) {
      // لا نستطيع تحديد ownerId من webhook
      // الحل الأفضل: يُنشئ المستخدم المحادثة من الواجهة أولًا
      return;
    }

    await convRef.collection('messages').add({
      direction: 'in',
      text: msg.text,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await convRef.update({ updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    // رد آلي
    const reply = await callAI([
      { role: 'system', content: 'أنت وكيل دعم ذكي. رد بإيجاز بالعربية.' },
      { role: 'user', content: msg.text }
    ], { maxTokens: 300 });

    await convRef.collection('messages').add({
      direction: 'out',
      text: reply,
      ai: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply })
    });
  } catch (e) {
    console.error('Telegram webhook error:', e);
  }
});