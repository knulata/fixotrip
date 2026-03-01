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
    response: `Ugh, flight problems are the worst — but you're in the right place. We deal with these every single day.

*Quick tip while we get started:* Go to your airline's service desk NOW and ask to be rebooked on the next available flight. Don't wait in the phone queue — the desk is almost always faster.

To build your rescue plan, I need a few details:

1. Airline name
2. Flight number
3. What happened — cancelled, delayed, denied boarding?
4. Where are you right now?

*What you'll get for $19:*
Your personal step-by-step action plan — exactly what to say at the desk, which phone numbers to call, what compensation you're legally owed (most people don't claim this), and a Plan B if the first option falls through.

No charge if we can't help your situation.`
  },

  luggage: {
    keywords: ['luggage', 'baggage', 'bag', 'lost', 'delayed bag', 'suitcase', 'missing luggage'],
    response: `That's so frustrating — but don't worry, most "lost" bags are actually just delayed and show up within 48 hours.

*Do this right now if you haven't:* Go to your airline's baggage desk (before leaving the airport!) and file a PIR — Property Irregularity Report. This is your proof for compensation later. No PIR = much harder to claim.

To get your full rescue plan, tell me:

1. Which airline?
2. Flight number
3. Did you already file a PIR?
4. Where are you staying? (so we can arrange delivery)

*What you'll get for $19:*
A complete recovery plan — how to track your bag in real time, how to claim up to $1,800 in compensation for delayed luggage (yes, really — airlines owe you for essentials), exactly what receipts to keep, and what to do if it's declared lost.

No charge if we can't help.`
  },

  hotel: {
    keywords: ['hotel', 'airbnb', 'booking', 'reservation', 'room', 'accommodation', 'check-in', 'overbooked'],
    response: `Hotel problems when you're exhausted from traveling — I get it. Let's sort this out.

*Quick tip:* If they're saying your booking doesn't exist, open your confirmation email and show it at the front desk. Screenshot it now in case you lose signal. If you booked through a third party, call that platform first — they usually have more leverage than you do alone.

Tell me what's going on:

1. Hotel or Airbnb name
2. Where did you book? (Booking.com, Airbnb, direct, etc.)
3. What's the problem — overbooking, different room, cancellation, won't check you in?
4. Do you have a confirmation number?

*What you'll get for $19:*
Your action plan — the exact words to use at the desk, who to escalate to, how to get a free upgrade or alternative stay, and how to get a refund if they can't deliver. We know the policies these platforms don't advertise.

No charge if we can't help.`
  },

  visa: {
    keywords: ['visa', 'immigration', 'passport', 'border', 'denied entry', 'customs'],
    response: `Immigration issues are stressful, especially when you're standing there not knowing your rights. Let's figure this out.

*Important:* Stay calm and be polite with the officers — attitude matters a lot at the border. Don't sign anything you don't fully understand. You have the right to ask for an interpreter.

Tell me your situation:

1. Your nationality / passport country
2. Which country are you trying to enter?
3. What happened — denied entry, held at border, visa problem?
4. Do you have a valid visa or travel authorization?

*What you'll get for $19:*
A clear breakdown of your legal rights at this specific border, exactly what to say to the officers, alternative entry options if you're denied, and embassy/consulate contacts that can help right now.

No charge if we can't help.`
  },

  medical: {
    keywords: ['sick', 'hospital', 'doctor', 'medical', 'emergency', 'injured', 'pharmacy', 'medicine'],
    response: `*If this is life-threatening, call local emergency services first.* (Google "emergency number" + your country if you don't know it.)

For non-life-threatening situations — I can help you navigate healthcare in a foreign country, which is honestly one of the most confusing things a traveler can face.

*Quick tip:* If you have travel insurance, call their 24/7 hotline BEFORE going to a hospital — many policies require pre-authorization or they won't cover you. Your policy number is usually in your confirmation email.

Tell me:

1. Where are you? (city and country)
2. What's the medical issue?
3. Do you have travel insurance?

*What you'll get for $19:*
Vetted English-speaking doctors/hospitals near you, how to navigate your insurance claim so you actually get reimbursed, what paperwork to collect at the hospital, and pharmacy alternatives if you need medication that's branded differently abroad.

No charge if we can't help.`
  },

  scam: {
    keywords: ['scam', 'scammed', 'stolen', 'robbed', 'theft', 'pickpocket', 'fraud'],
    response: `I'm really sorry this happened to you. Take a deep breath — we've helped people through this many times and there's usually more you can recover than you think.

*Do this right now:*
If cards were stolen → call your bank and freeze them immediately. Most banks have a number on their website you can call collect from abroad. If your passport was taken → don't panic, your embassy can issue an emergency travel document.

Tell me what happened:

1. Where are you? (city and country)
2. What happened?
3. What was taken — passport, money, cards, phone?
4. Have you contacted police yet?

*What you'll get for $19:*
Your complete recovery plan — local police report process (with translated phrases if needed), embassy contacts and emergency document procedures, how to get emergency cash sent to you, insurance claim steps, and how to secure your accounts and identity.

No charge if we can't help.`
  }
};

// Greeting/initial response
const GREETING_RESPONSE = `Hey! Welcome to *FixoTrip* — we help travelers who are stuck, stranded, or stressed.

Tell me what's going on and I'll get you sorted:

• Flight cancelled or delayed
• Lost or delayed luggage
• Hotel or Airbnb nightmare
• Visa or immigration trouble
• Need a doctor abroad
• Got scammed or robbed
• Something else entirely

Just describe your situation — the more detail the better. I'll give you a quick tip right away, and if you want the full rescue plan it's a $19 flat fee.

*You only pay if we can actually help. No risk.*`;

// Confirmation after received details
const DETAILS_RECEIVED = `Got it — thanks for the details.

I'm pulling together your rescue plan now. A FixoTrip specialist is reviewing your case and will have your personalized action plan ready within a few minutes.

I'll send you the payment link shortly. Remember — if we look at your situation and can't help, you pay nothing.`;

// Payment instructions
const PAYMENT_INSTRUCTIONS = `Your rescue plan is ready.

To unlock it, pay $19 USD via PayPal:
👉 https://www.paypal.com/ncp/payment/K8PSJVA9EJL2J

*Here's what you'll receive:*
• Your personalized step-by-step action plan
• Exact phone numbers to call (tested and working)
• Word-for-word scripts — what to say to get results
• Compensation and refunds you're legally owed
• Plan B and C if the first approach doesn't work
• Follow-up support until your issue is resolved

Reply *PAID* once you've completed the payment and I'll send everything right away.`;

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
      response = `*Thank you!* Payment received.

I'm finalizing your personalized rescue plan now. You'll have it in your hands within 10 minutes — with every step laid out so you know exactly what to do next.

While I prepare it — is there anything else about your situation I should know? Any update helps me make the plan more specific to you.`;
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
        response = `I want to make sure I give you the right help. Could you tell me a bit more?

For example:
- What exactly happened?
- Where are you right now?
- Is there a deadline or time pressure?

The more specific you are, the more useful your rescue plan will be.`;
      }

    } else if (convo.state === 'details_received') {
      // Already received details, they're adding more info
      if (hasEnoughDetails(message)) {
        response = `Thanks — that's really helpful. I'm adding this to your case now.

A FixoTrip specialist is putting together your action plan. You'll hear back within a few minutes.`;
        await notifyAdmin(sender, 'ADDITIONAL INFO: ' + message, convo.category);
      } else {
        response = PAYMENT_INSTRUCTIONS;
        convo.state = 'awaiting_payment';
      }

    } else if (convo.state === 'awaiting_payment') {
      response = `Just checking in — your rescue plan is ready and waiting. Once you complete the $19 payment, I'll send it right over.

👉 https://www.paypal.com/ncp/payment/K8PSJVA9EJL2J

Reply *PAID* when done. And remember — if your situation changes or you have more details, just send them over.`;
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
