# RTMS Financial Consultation Intelligence - Node.js

This project demonstrates how to build an AI-powered financial consultation assistant using Zoom's RTMS (Real-Time Media Streaming) with AssemblyAI's Universal Streaming v3 and Anthropic's Claude for real-time conversation analysis.

> [!IMPORTANT]
> **Confidential under NDA - Do not distribute during developer preview**<br />
> This document contains confidential information that requires an NDA. It is intended only for partners in the Zoom RTMS developer preview.
> Participation in the RTMS Developer Preview, including access to and use of these materials, is subject to [Zoom's Beta Program - Terms of Use](https://www.zoom.com/en/trust/beta-terms-and-conditions/).

## 🎯 What This System Does

This intelligent assistant monitors financial consultation conversations in real-time and provides:

- **📝 Live Transcription**: Real-time speech-to-text using AssemblyAI's latest Universal Streaming v3 model
- **💎 FAINT Qualification**: Tracks Funds, Authority, Interest, Need, and Timing throughout the conversation
- **🧠 Smart Analysis**: Uses Claude AI to extract key insights and identify opportunities
- **💡 Advisor Coaching**: Real-time suggestions and reminders for financial advisors
- **⚠️ Concern Detection**: Identifies client worries and suggests addressing strategies
- **❓ Strategic Questions**: AI-generated questions to gather more valuable information
- **📊 Live Web Dashboard**: Beautiful web interface with real-time updates and dual-tab view

## 🌐 Web Interface Features

### Dual-Tab Dashboard
- **📊 Financial Intelligence Tab**: Live FAINT analysis, client insights, and advisor recommendations
- **📝 Live Transcript Tab**: Real-time conversation transcript with timestamps
- **🔄 Auto-Refresh**: 2-second updates during active calls, 10-second during standby
- **📱 Responsive Design**: Works seamlessly on desktop, tablet, and mobile

### Professional UI
- **Modern Design**: Gradient backgrounds, smooth animations, and card-based layout
- **Color-Coded Insights**: Visual distinction between concerns, questions, and reminders
- **Status Indicators**: Real-time system health monitoring in the header
- **Empty States**: Helpful messaging when waiting for consultation to begin

## 🏗️ Setup

### Prerequisites
- Node.js 18+ 
- Zoom account with RTMS enabled
- AssemblyAI API key
- Anthropic API key
- ffmpeg (for audio processing)

### Installation

1. **Clone and install dependencies**:
```bash
git clone <repository-url>
cd rtms-financial-consultation
npm install
```

2. **Install required packages**:
```bash
npm install express ws dotenv helmet assemblyai @anthropic-ai/sdk
```

### Configuration

1. **Create environment file**:
```bash
cp .env.example .env
```

2. **Configure your .env file**:
```env
# Zoom RTMS Configuration
ZOOM_SECRET_TOKEN=your_zoom_secret_token
ZM_CLIENT_ID=your_zoom_client_id
ZM_CLIENT_SECRET=your_zoom_client_secret

# AI Services
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

3. **Set up Zoom RTMS Webhook**:
   - Configure your Zoom marketplace app to send webhooks to: `https://your-domain.com/webhook`
   - Enable RTMS events: `meeting.rtms_started` and `meeting.rtms_stopped`

## 🚀 Usage

### Start the System
```bash
npm start
```

The system will start on port 8080 and display:
```
🌐 Financial Consultation Intelligence System running at http://localhost:8080
🔗 Webhook endpoint at http://localhost:8080/webhook
💡 Make sure your environment variables are set in .env
```

### Access the Dashboard
Open your browser to `http://localhost:8080` to view the live dashboard.

### Start a Consultation
1. Begin a Zoom meeting with RTMS enabled
2. The dashboard will automatically switch to "ACTIVE" status
3. Watch real-time transcription and AI analysis appear in both tabs
4. Monitor financial insights as the conversation progresses

## 🎭 System Flow

1. **🎧 Zoom Connection**: Direct WebSocket connection to Zoom RTMS (no SDK required)
2. **🎙️ Audio Streaming**: Base64-decoded audio chunks sent to AssemblyAI in 100ms intervals
3. **📝 Real-Time Transcription**: AssemblyAI v3 provides ultra-low latency speech-to-text
4. **🤖 AI Analysis**: Claude 3.5 Sonnet analyzes each transcript segment for financial insights
5. **📊 Live Updates**: Web dashboard refreshes every 2 seconds during active calls
6. **💾 Data Persistence**: Conversation logs and final reports saved to `./consultation_logs/`

## 📊 AI Analysis Features

### FAINT Qualification Framework
- **💰 Funds**: Financial capacity and assets identification
- **👤 Authority**: Decision-making power assessment  
- **🎯 Interest**: Engagement and investment appetite
- **🎪 Need**: Financial goals and problems identification
- **⏰ Timing**: Timeline for financial decisions

### Smart Coaching
- **Consultation Summary**: Key developments extracted automatically
- **Advisor Reminders**: AI-generated coaching suggestions
- **Client Concerns**: Worry identification with addressing strategies
- **Strategic Questions**: Specific questions to gather valuable information
- **Client Information**: Personal and financial background compilation

## 🛠️ Technical Architecture

### Audio Processing Pipeline
- **Direct RTMS Protocol**: WebSocket connection without SDK dependencies
- **Base64 Audio Decoding**: Handles Zoom's new JSON-based audio format
- **Buffered Streaming**: 100ms chunks optimized for AssemblyAI v3
- **Real-Time Processing**: Sub-second latency from speech to insights

### Web Dashboard Architecture
- **Express.js Backend**: RESTful API for dashboard data
- **Real-Time Updates**: Efficient polling with adaptive refresh rates
- **Responsive Frontend**: Mobile-first design with CSS Grid/Flexbox
- **Error Handling**: Graceful degradation and connection recovery

### AI Integration
- **Anthropic Claude 3.5**: Tool-based structured data extraction
- **AssemblyAI v3**: Universal Streaming model with turn detection
- **Conversation Context**: Full conversation history maintained for accuracy
- **Real-Time Processing**: Insights generated as conversation progresses

## 📁 Output Files

The system generates structured JSON files:
- `consultation_logs/{meeting_id}.json` - Live conversation tracking
- `consultation_logs/{meeting_id}_final_report.json` - Complete analysis with full transcript

### Sample Output Structure
```json
{
  "conversationHistory": [...],
  "financialData": {
    "summary": ["Client has $5M in assets", "..."],
    "faint": {
      "funds": "$5 million in bank deposits",
      "authority": "Primary decision maker",
      "interest": "High interest in wealth management",
      "need": "Portfolio diversification",
      "timing": "Within 3 months"
    },
    "clientInfo": "Retired executive, age 65...",
    "advisorReminders": ["Follow up on risk tolerance", "..."],
    "concerns": [{"concern": "Market volatility", "addressing_strategy": "..."}],
    "strategicQuestions": [{"question": "...", "purpose": "..."}]
  }
}
```

## 🔒 Security & Privacy

- **Secure Audio Handling**: Audio processed in real-time, not stored persistently
- **Local Data Storage**: All conversation logs stored locally
- **Environment Variables**: Secure API key management
- **HTTPS Support**: Production-ready with proper SSL termination
- **Helmet.js Security**: HTTP security headers and CSP protection
- **Financial Compliance**: Designed for regulated financial environments

## 🚀 Production Deployment

### Environment Setup
```bash
# Production environment variables
NODE_ENV=production
PORT=8080
```

### Docker Deployment
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8080
CMD ["npm", "start"]
```

### Health Monitoring
The system provides health endpoints:
- `GET /api/status` - System health and status
- Built-in memory usage and uptime monitoring
- Automatic connection recovery and error handling

## 📱 Mobile Support

The dashboard is fully responsive and optimized for:
- **Desktop**: Full dual-pane view with rich interactions
- **Tablet**: Adaptive layout with touch-friendly controls  
- **Mobile**: Single-column layout with swipe navigation between tabs

## 🎯 Use Cases

- **Financial Advisory Meetings**: Real-time client qualification and coaching
- **Sales Consultations**: Lead qualification and objection handling
- **Compliance Monitoring**: Automatic conversation logging and analysis
- **Training & Development**: Advisor performance insights and improvement suggestions
- **Client Relationship Management**: Structured data extraction for CRM integration

This system transforms traditional financial consultations into data-driven, AI-enhanced experiences that help advisors provide better service while ensuring no critical information is missed. The beautiful web interface makes it easy to monitor conversations in real-time and access valuable insights instantly.