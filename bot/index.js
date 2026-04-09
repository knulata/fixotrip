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
// TODO: move to Postgres before scaling past ~1k users.
const conversations = new Map();

// Watched trips: sender -> array of { id, flightNumber, date, route, status, lastChecked, createdAt }
// TODO: move to Postgres. In-memory means watches are lost on every cold start.
const trips = new Map();
let nextTripId = 1;

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

## Two products

FixoTrip offers two services, and you should match the user to the right one:

1. **Watch My Trip — FREE forever.** We monitor a user's flight 24/7 and ping them on WhatsApp the moment anything changes (delay, gate change, cancellation). No app, no signup. Use the \`start_watching_trip\` tool whenever a user wants you to watch a flight, expresses pre-trip anxiety, or forwards an airline confirmation. Always favor offering this when a user has an upcoming trip — it's free, it builds trust, and it's the wedge into the paid product.

2. **Emergency Help — $19 flat fee.** If a user is already stuck (cancelled, delayed, lost luggage, denied boarding, etc.), help them with the existing rescue-plan flow.

When a watched flight is auto-detected as cancelled by our poller, the user will message you and you should immediately move them into the paid Emergency Help flow — they already know us and trust us.

## Conversation flow

### Phase 1: Greeting & Problem Detection
When someone first messages:
- Greet them warmly and ask what's going on
- Mention BOTH options briefly: free flight monitoring OR paid emergency help
- If they describe a problem, immediately give ONE free actionable tip to build trust
- This free tip should be specific and genuinely useful — show you know your stuff
- If they have an UPCOMING trip (not yet broken), offer to watch it for free via \`start_watching_trip\`

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
      name: 'start_watching_trip',
      description: 'Start monitoring a user\'s flight for free. Call this whenever a user asks you to watch/monitor/track a flight, forwards an airline confirmation, or expresses pre-trip anxiety. Free forever — always offer it before pushing the paid product.',
      parameters: {
        type: 'object',
        properties: {
          flight_number: {
            type: 'string',
            description: 'IATA flight code with no spaces, e.g. "GA820", "QZ250", "UA123". If the user gave airline name only, use your knowledge to map it (e.g. "Garuda 820" → "GA820").'
          },
          date: {
            type: 'string',
            description: 'Departure date in ISO format YYYY-MM-DD. Resolve relative dates ("tomorrow", "next Tuesday") to absolute dates using the current date.'
          },
          route: {
            type: 'string',
            description: 'Optional route as IATA codes, e.g. "CGK-DPS" or "JFK-LHR". Omit if unknown.'
          }
        },
        required: ['flight_number', 'date']
      }
    }
  },
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

        if (toolCall.function.name === 'start_watching_trip') {
          const trip = saveWatchedTrip(sender, args.flight_number, args.date, args.route);
          await notifyAdmin(
            sender,
            `New watch: ${trip.flightNumber} on ${trip.date}${trip.route ? ` (${trip.route})` : ''}`,
            'watch'
          );
          convo.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Trip saved. id=${trip.id}, flight=${trip.flightNumber}, date=${trip.date}. Confirm to the user that we're now watching their trip 24/7 for free, will WhatsApp them on any change (delay, gate change, cancellation), and remind them they can also reach out anytime if something goes wrong before then.`
          });

        } else if (toolCall.function.name === 'send_payment_link') {
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

// --- Free trip monitoring ---

function saveWatchedTrip(sender, flightNumber, date, route) {
  const trip = {
    id: nextTripId++,
    sender,
    flightNumber: String(flightNumber || '').toUpperCase().replace(/\s+/g, ''),
    date,
    route: route || null,
    status: 'scheduled',
    lastChecked: null,
    createdAt: Date.now()
  };
  const list = trips.get(sender) || [];
  list.push(trip);
  trips.set(sender, list);
  return trip;
}

// Stub: returns null if AVIATIONSTACK_KEY not set, else queries AviationStack.
async function checkFlightStatus(flightNumber, date) {
  const key = process.env.AVIATIONSTACK_KEY;
  if (!key) {
    console.log(`[flight-status] stub: would check ${flightNumber} on ${date}`);
    return null;
  }
  try {
    const res = await axios.get('http://api.aviationstack.com/v1/flights', {
      params: { access_key: key, flight_iata: flightNumber, flight_date: date },
      timeout: 10000
    });
    const flight = res.data?.data?.[0];
    if (!flight) return null;
    return {
      status: flight.flight_status, // scheduled | active | landed | cancelled | incident | diverted
      departure: flight.departure,
      arrival: flight.arrival
    };
  } catch (err) {
    console.error('[flight-status] error:', err.message);
    return null;
  }
}

async function pollWatchedTrips() {
  const today = new Date().toISOString().slice(0, 10);
  for (const [sender, list] of trips) {
    for (const trip of list) {
      if (trip.date < today) continue; // past trip
      if (['cancelled-notified', 'expired'].includes(trip.status)) continue;

      const result = await checkFlightStatus(trip.flightNumber, trip.date);
      trip.lastChecked = Date.now();
      if (!result) continue;

      const prevStatus = trip.status;
      trip.status = result.status;

      // Auto-notify on cancellation. We feed it through the LLM bot so the
      // language and tone match the existing conversation context.
      if (result.status === 'cancelled' && prevStatus !== 'cancelled') {
        const trigger = `[SYSTEM] FixoTrip's flight monitor just detected that flight ${trip.flightNumber} on ${trip.date} (which this user asked us to watch) has been CANCELLED by the airline. Tell them right away in their language, with empathy. Offer the paid Emergency Help flow ($19) — finding a replacement flight, scripts for the airline counter, EU261/Montreal compensation claim. Do NOT include the payment link yet — first ask if they want help, then collect a few details, then call send_payment_link.`;
        try {
          const reply = await getAIResponse(sender, trigger);
          if (reply) await sendMessage(sender, reply);
        } catch (err) {
          console.error('[poller] LLM notify failed:', err.message);
        }
        trip.status = 'cancelled-notified';
        await notifyAdmin(sender, `Auto-detected cancellation: ${trip.flightNumber} ${trip.date}`, 'flight');
      }
    }
  }
}

// Run the poller every 15 minutes on long-running hosts (Railway/Render/Fly).
// On Vercel serverless, disable this and hit POST /poll from external cron instead.
const POLL_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  pollWatchedTrips().catch(err => console.error('[poller] error:', err));
}, POLL_INTERVAL_MS);

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
  let tripCount = 0;
  for (const list of trips.values()) tripCount += list.length;
  res.json({
    status: 'FixoTrip Bot Running (AI)',
    conversations: conversations.size,
    watchedTrips: tripCount
  });
});

// Manual poll trigger — for serverless cron (Vercel Cron, GH Actions, cron-job.org).
// Set POLL_SECRET in env and pass it as `x-poll-secret` header.
app.post('/poll', async (req, res) => {
  const secret = process.env.POLL_SECRET;
  if (secret && req.headers['x-poll-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await pollWatchedTrips();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
