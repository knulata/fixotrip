const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fonnte API config
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;
const FONNTE_API = 'https://api.fonnte.com/send';

// Store conversation states (use Redis in production)
const conversations = new Map();

// Problem categories and responses
const CATEGORIES = {
  flight: {
    keywords: ['flight', 'cancelled', 'canceled', 'delayed', 'airline', 'boarding', 'missed flight', 'connection', 'layover', 'airport'],
    response: `✈️ *Flight Emergency*

I can help with flight issues! To assist you quickly, please share:

1️⃣ Airline name
2️⃣ Flight number
3️⃣ Date of flight
4️⃣ What happened (cancelled/delayed/denied boarding)
5️⃣ Where are you now?

Once I have these details, I'll find the best solution for you.

💰 *Fee: $19 via PayPal (only if we can help)*`
  },

  luggage: {
    keywords: ['luggage', 'baggage', 'bag', 'lost', 'delayed bag', 'suitcase', 'missing luggage'],
    response: `🧳 *Lost/Delayed Luggage*

Sorry about your luggage! To help you:

1️⃣ Which airline?
2️⃣ Flight number
3️⃣ Do you have a PIR number? (Property Irregularity Report from the airline)
4️⃣ What was in the bag? (brief description)
5️⃣ Where are you staying?

I'll guide you through getting compensation and tracking your bag.

💰 *Fee: $19 via PayPal (only if we can help)*`
  },

  hotel: {
    keywords: ['hotel', 'airbnb', 'booking', 'reservation', 'room', 'accommodation', 'check-in', 'overbooked'],
    response: `🏨 *Hotel/Accommodation Problem*

I can help resolve this! Please tell me:

1️⃣ Hotel/Airbnb name
2️⃣ Booking platform (Booking.com, Airbnb, direct, etc.)
3️⃣ Check-in date
4️⃣ What's the problem?
5️⃣ Do you have a confirmation number?

I'll help you get a solution or refund.

💰 *Fee: $19 via PayPal (only if we can help)*`
  },

  visa: {
    keywords: ['visa', 'immigration', 'passport', 'border', 'denied entry', 'customs'],
    response: `🛂 *Visa/Immigration Issue*

This can be stressful. Please share:

1️⃣ Your nationality
2️⃣ Which country are you trying to enter?
3️⃣ What happened at immigration?
4️⃣ Do you have a valid visa/travel authorization?

I'll advise on your options.

💰 *Fee: $19 via PayPal (only if we can help)*`
  },

  medical: {
    keywords: ['sick', 'hospital', 'doctor', 'medical', 'emergency', 'injured', 'pharmacy', 'medicine'],
    response: `🏥 *Medical Emergency*

If this is a life-threatening emergency, please call local emergency services first!

For non-urgent medical help, tell me:

1️⃣ Where are you? (city/country)
2️⃣ What's the medical issue?
3️⃣ Do you have travel insurance?

I'll help you find medical care and navigate insurance.

💰 *Fee: $19 via PayPal (only if we can help)*`
  },

  scam: {
    keywords: ['scam', 'scammed', 'stolen', 'robbed', 'theft', 'pickpocket', 'fraud'],
    response: `🚨 *Scam/Theft Report*

I'm sorry this happened. Let me help:

1️⃣ Where are you? (city/country)
2️⃣ What happened?
3️⃣ What was taken? (passport, money, cards, etc.)
4️⃣ Have you contacted local police?

I'll guide you through reporting and recovery.

💰 *Fee: $19 via PayPal (only if we can help)*`
  }
};

// Greeting/initial response
const GREETING_RESPONSE = `👋 *Welcome to FixoTrip!*

We help travelers with emergencies 24/7.

What's your problem?
• ✈️ Flight cancelled/delayed
• 🧳 Lost luggage
• 🏨 Hotel/Airbnb issue
• 🛂 Visa/immigration problem
• 🏥 Medical emergency
• 🚨 Scam or theft
• ❓ Other travel problem

Just describe your situation and I'll help!

💰 *$19 flat fee - you only pay if we can help*`;

// Confirmation after receiving details
const DETAILS_RECEIVED = `✅ *Got it!*

I'm reviewing your case now. A FixoTrip agent will respond within 5 minutes with a solution.

If we can help, I'll send a PayPal link for $19.
If we can't help your situation, no charge.

Hang tight! 🙏`;

// Payment instructions
const PAYMENT_INSTRUCTIONS = `💳 *Payment Instructions*

Pay $19 USD via PayPal:
👉 https://www.paypal.com/ncp/payment/K8PSJVA9EJL2J

Once payment is confirmed, I'll send your complete rescue plan with:
• Step-by-step instructions
• Phone numbers to call
• What to say
• Compensation you're entitled to

Reply "PAID" after payment.`;

// Detect category from message
function detectCategory(message) {
  const lowerMessage = message.toLowerCase();

  for (const [category, data] of Object.entries(CATEGORIES)) {
    for (const keyword of data.keywords) {
      if (lowerMessage.includes(keyword)) {
        return category;
      }
    }
  }
  return null;
}

// Check if message contains enough details
function hasEnoughDetails(message) {
  // Simple heuristic: message is long enough and contains some specifics
  return message.length > 100 ||
    (message.match(/\d+/g) || []).length >= 2 || // Has numbers (flight numbers, dates)
    message.includes('from') ||
    message.includes('to');
}

// Check if it's a greeting
function isGreeting(message) {
  const greetings = ['hi', 'hello', 'hey', 'help', 'halo', 'hai', 'hola', 'start', 'menu'];
  const lowerMessage = message.toLowerCase().trim();
  return greetings.some(g => lowerMessage === g || lowerMessage.startsWith(g + ' ') || lowerMessage.startsWith(g + ','));
}

// Check if confirming payment
function isPaymentConfirmation(message) {
  const confirmations = ['paid', 'done', 'sent', 'transferred', 'sudah bayar', 'sudah transfer'];
  return confirmations.some(c => message.toLowerCase().includes(c));
}

// Send message via Fonnte
async function sendMessage(to, message) {
  try {
    const response = await axios.post(FONNTE_API, {
      target: to,
      message: message,
      countryCode: '62' // Default to Indonesia, adjust as needed
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

// Notify admin of new case
async function notifyAdmin(sender, message, category) {
  const adminNumber = process.env.ADMIN_PHONE;
  if (!adminNumber) return;

  const notification = `🆘 *New FixoTrip Case*

From: ${sender}
Category: ${category || 'Uncategorized'}
Message: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}

Reply to this customer in WhatsApp.`;

  await sendMessage(adminNumber, notification);
}

// Main webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const { sender, message, device } = req.body;

    // Ignore if no message or sender
    if (!sender || !message) {
      return res.status(200).json({ status: 'ignored' });
    }

    console.log(`Received from ${sender}: ${message}`);

    // Get or create conversation state
    let convo = conversations.get(sender) || {
      state: 'new',
      category: null,
      messageCount: 0,
      lastMessage: Date.now()
    };

    convo.messageCount++;
    convo.lastMessage = Date.now();

    let response;

    // Handle based on conversation state
    if (isPaymentConfirmation(message)) {
      response = `✅ *Thank you!*

I'm checking your payment now. Once confirmed, I'll send your complete rescue plan within 10 minutes.

If you have any additional details about your situation, feel free to share them now.`;
      convo.state = 'paid';
      await notifyAdmin(sender, 'PAYMENT CONFIRMATION: ' + message, convo.category);

    } else if (isGreeting(message) || convo.state === 'new') {
      // New conversation or greeting
      response = GREETING_RESPONSE;
      convo.state = 'greeted';

    } else if (convo.state === 'greeted' || convo.state === 'categorized') {
      // Try to categorize the problem
      const category = detectCategory(message);

      if (category) {
        convo.category = category;
        convo.state = 'categorized';
        response = CATEGORIES[category].response;
      } else if (hasEnoughDetails(message)) {
        // Has details but unclear category
        response = DETAILS_RECEIVED;
        convo.state = 'details_received';
        await notifyAdmin(sender, message, 'Other');
      } else {
        // Ask for more details
        response = `I want to help! Could you tell me more about your travel emergency?

For example:
- What happened?
- Where are you now?
- When did this happen?

The more details you share, the faster I can help.`;
      }

    } else if (convo.state === 'details_received') {
      // Already received details, they're adding more info
      if (hasEnoughDetails(message)) {
        response = `Thanks for the additional details!

A FixoTrip agent is reviewing your case and will respond within 5 minutes.`;
        await notifyAdmin(sender, 'ADDITIONAL INFO: ' + message, convo.category);
      } else {
        response = PAYMENT_INSTRUCTIONS;
        convo.state = 'awaiting_payment';
      }

    } else if (convo.state === 'awaiting_payment') {
      response = `I'm still waiting for your payment to proceed.

${PAYMENT_INSTRUCTIONS}

Or if you have more details to share, please send them.`;
    }

    // Save conversation state
    conversations.set(sender, convo);

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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'FixoTrip Bot Running',
    conversations: conversations.size
  });
});

// Clean up old conversations (run periodically)
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [sender, convo] of conversations) {
    if (convo.lastMessage < oneHourAgo) {
      conversations.delete(sender);
    }
  }
}, 60 * 60 * 1000); // Every hour

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FixoTrip bot running on port ${PORT}`);
});
