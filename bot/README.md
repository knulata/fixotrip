# FixoTrip WhatsApp Bot

Automated WhatsApp responses for travel emergencies.

## Setup

### 1. Install dependencies
```bash
cd bot
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env`:
- `FONNTE_TOKEN` - Get from fonnte.com dashboard
- `ADMIN_PHONE` - Your WhatsApp number for notifications

### 3. Run locally
```bash
npm run dev
```

### 4. Deploy to Railway/Render/Vercel

**Railway (Recommended):**
```bash
railway login
railway init
railway up
```

**Or Render:**
1. Connect GitHub repo
2. Add environment variables
3. Deploy

### 5. Configure Fonnte Webhook

1. Go to fonnte.com dashboard
2. Select your device
3. Set webhook URL: `https://your-app-url.com/webhook`
4. Save

## How It Works

1. Customer sends message to FixoTrip WhatsApp
2. Bot detects problem category (flight, luggage, hotel, etc.)
3. Bot asks for relevant details
4. Admin gets notified of new case
5. Bot sends payment instructions
6. Admin reviews and sends solution

## Conversation Flow

```
Customer: Hi
Bot: Welcome message + menu

Customer: My flight was cancelled
Bot: Flight-specific questions (airline, flight number, etc.)

Customer: [provides details]
Bot: "Got it! Agent will respond in 5 minutes"
Admin: Gets notification

Customer: Paid
Bot: Confirms, admin sends solution
```

## Customization

Edit `CATEGORIES` in `index.js` to:
- Add new problem types
- Change response templates
- Modify keywords
