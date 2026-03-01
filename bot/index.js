const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Config
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;
const FONNTE_API = 'https://api.fonnte.com/send';
const PAYPAL_LINK = 'https://www.paypal.com/ncp/payment/K8PSJVA9EJL2J';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Store conversations: sender -> { messages: [], state, lastMessage }
const conversations = new Map();

// System prompt — the brain of the bot
const SYSTEM_PROMPT = `You are a FixoTrip travel emergency specialist on WhatsApp. You help travelers who are stuck, stranded, or stressed — 24/7 worldwide.

## Your personality
- Warm, calm, and confident — like a knowledgeable friend who's handled this 100 times
- Empathetic but action-oriented — acknowledge their stress, then immediately help
- Direct and concise — this is WhatsApp, not email. Keep messages short and scannable
- Use *bold* for emphasis (WhatsApp formatting). Never use markdown headers or bullet points with dashes — use • instead

## Your knowledge
You are an expert in:
- Airline passenger rights: EU261 (Europe), DOT rules (US), Montreal Convention (international)
- Lost luggage claims, PIR filing, compensation amounts
- Hotel overbooking rights, platform dispute processes (Booking.com, Airbnb, Expedia)
- Visa and immigration procedures, emergency travel documents
- Travel insurance claims, medical emergencies abroad
- Scam recovery, police reports abroad, embassy services
- General travel problem-solving across 190+ countries

## Conversation flow

### Phase 1: Greeting & Problem Detection
When someone first messages:
- Greet them warmly and ask what's going on
- If they describe a problem, immediately give ONE free actionable tip to build trust
- This free tip should be specific and genuinely useful — show you know your stuff

### Phase 2: Detail Collection
Ask for the specific details you need to build their rescue plan. Adapt your questions to their specific problem — don't use a generic form. Key details to collect:
- What exactly happened
- Where they are (city/country/airport)
- Airline/hotel/service provider names
- Flight numbers, booking references, dates
- What they've already tried
- Any time pressure or deadlines

Keep asking naturally until you have enough to build a real plan. Don't rush to payment.

### Phase 3: Payment
Once you have enough details, tell them their rescue plan is ready and share the payment link. Frame it as:
- Here's what you'll get (be specific to THEIR situation, not generic)
- $19 flat fee
- No charge if we can't help
- Payment link: ${PAYPAL_LINK}

### Phase 4: After Payment
When they confirm payment (say "paid", "done", "sent", etc.):
- Thank them
- Tell them the plan is being finalized
- Internally: generate their rescue plan (the admin will review and send it)

### Phase 5: Rescue Plan Generation
When asked to generate a rescue plan (via function call), create a comprehensive, personalized action plan with:
- Step-by-step instructions in priority order
- Exact phone numbers and contact info
- Word-for-word scripts for what to say
- Legal rights and compensation they're owed (cite specific regulations)
- Plan B and C if the first approach doesn't work
- Deadlines for filing claims
- What receipts/documents to keep

## Important rules
- NEVER make up phone numbers or specific contact details you're not sure about — say "I'll include verified contact info in your plan"
- NEVER give dangerous medical or legal advice — always caveat with "consult a professional"
- If someone has a life-threatening emergency, tell them to call local emergency services FIRST
- Keep WhatsApp messages under 300 words — break into multiple messages if needed
- Respond in whatever language the customer uses
- Don't be pushy about payment — let them ask questions first
- If you genuinely can't help their situation, say so honestly — don't upsell`;

// Function definitions for OpenAI
const tools = [
  {
    type: 'function',
    function: {
      name: 'send_payment_link',
      description: 'Send the payment link to the customer. Call this when you have collected enough details about their problem and are ready to offer the rescue plan.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Brief summary of the customer problem for admin notification'
          },
          category: {
            type: 'string',
            enum: ['flight', 'luggage', 'hotel', 'visa', 'medical', 'scam', 'other'],
            description: 'Problem category'
          }
        },
        required: ['summary', 'category']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notify_payment_received',
      description: 'Notify admin that payment was received and include a draft rescue plan. Call this when the customer confirms they have paid.',
      parameters: {
        type: 'object',
        properties: {
          rescue_plan: {
            type: 'string',
            description: 'The full personalized rescue plan to send to the customer. Include step-by-step instructions, phone numbers, scripts, legal rights, and backup plans.'
          },
          summary: {
            type: 'string',
            description: 'Brief summary for admin'
          }
        },
        required: ['rescue_plan', 'summary']
      }
    }
  }
];

// Get AI response for a conversation
async function getAIResponse(sender, userMessage) {
  let convo = conversations.get(sender);
  if (!convo) {
    convo = {
      messages: [],
      state: 'active',
      lastMessage: Date.now()
    };
    conversations.set(sender, convo);
  }

  convo.messages.push({ role: 'user', content: userMessage });
  convo.lastMessage = Date.now();

  // Keep conversation history manageable (last 20 messages)
  if (convo.messages.length > 20) {
    convo.messages = convo.messages.slice(-20);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...convo.messages
      ],
      tools: tools,
      max_tokens: 500,
      temperature: 0.7
    });

    const choice = completion.choices[0];
    const assistantMessage = choice.message;

    // Store assistant message in history
    convo.messages.push(assistantMessage);

    // Handle function calls
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const results = [];

      for (const toolCall of assistantMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);

        if (toolCall.function.name === 'send_payment_link') {
          await notifyAdmin(sender, `NEW CASE (${args.category}): ${args.summary}`, args.category);
          convo.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Payment link context ready. Include the payment link in your response.'
          });

        } else if (toolCall.function.name === 'notify_payment_received') {
          await notifyAdmin(
            sender,
            `PAID — ${args.summary}\n\n*Draft Rescue Plan:*\n${args.rescue_plan}`,
            'paid'
          );
          convo.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Admin notified with rescue plan draft. Confirm to customer that plan is being finalized.'
          });
        }
      }

      // Get follow-up response after function calls
      const followUp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...convo.messages
        ],
        max_tokens: 500,
        temperature: 0.7
      });

      const followUpMessage = followUp.choices[0].message;
      convo.messages.push(followUpMessage);
      return followUpMessage.content;
    }

    return assistantMessage.content;

  } catch (error) {
    console.error('OpenAI error:', error.message);
    // Fallback response
    return `Thanks for your message! I'm having a brief technical issue but a FixoTrip specialist will get back to you shortly. Please share as many details as you can about your situation in the meantime.`;
  }
}

// Send message via Fonnte
async function sendMessage(to, message) {
  try {
    const response = await axios.post(FONNTE_API, {
      target: to,
      message: message,
      countryCode: '62'
    }, {
      headers: {
        'Authorization': FONNTE_TOKEN
      }
    });

    console.log(`Message sent to ${to}:`, response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
    throw error;
  }
}

// Notify admin
async function notifyAdmin(sender, message, category) {
  const adminNumber = process.env.ADMIN_PHONE;
  if (!adminNumber) return;

  const notification = `*FixoTrip Case*

From: ${sender}
Category: ${category || 'Unknown'}

${message.substring(0, 1000)}${message.length > 1000 ? '...' : ''}`;

  await sendMessage(adminNumber, notification);
}

// Main webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const { sender, message } = req.body;

    if (!sender || !message) {
      return res.status(200).json({ status: 'ignored' });
    }

    // Ignore messages from admin number to prevent loops
    const adminNumber = process.env.ADMIN_PHONE;
    if (adminNumber && sender.includes(adminNumber.replace(/^62/, ''))) {
      return res.status(200).json({ status: 'ignored_admin' });
    }

    console.log(`Received from ${sender}: ${message}`);

    // Get AI response
    const response = await getAIResponse(sender, message);

    // Send response
    if (response) {
      await sendMessage(sender, response);
    }

    res.status(200).json({ status: 'ok' });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'FixoTrip Bot Running (AI)',
    conversations: conversations.size
  });
});

// Clean up old conversations every hour
setInterval(() => {
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const [sender, convo] of conversations) {
    if (convo.lastMessage < twoHoursAgo) {
      conversations.delete(sender);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FixoTrip bot running on port ${PORT}`);
});
