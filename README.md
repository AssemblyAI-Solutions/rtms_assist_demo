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
- **📊 Live Dashboard**: Visual terminal display of all insights as they develop

## 🏗️ Setup

### Prerequisites
- Node.js 16+ 
- SSH keys configured with GitHub
- RTMS Developer Preview access
- AssemblyAI API key
- Anthropic API key

### Installation

1. **Install RTMS SDK** (requires developer preview access):
```bash
npm install github:zoom/rtms
```

2. **Install additional dependencies**:
```bash
npm install ws querystring assemblyai @anthropic-ai/sdk
```

3. **Fetch RTMS binaries** (Developer Preview Only):
```bash
npm run fetch -- your-token-goes-here
```

### Configuration

1. **Copy environment template**:
```bash
cp .env.example .env
```

2. **Configure your .env file**:
```env
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

## 🚀 Usage

Start the financial consultation intelligence system:

```bash
npm start
```

The system will:
1. 🎧 Connect to Zoom meetings via RTMS
2. 🎙️ Stream audio to AssemblyAI for real-time transcription  
3. 🤖 Analyze conversations with Claude AI
4. 📊 Display live insights in the terminal
5. 💾 Save detailed reports to `./consultation_logs/`

## 🎭 Testing

Use the included test script to simulate a financial consultation conversation. The AI will analyze the dialogue and provide real-time insights including FAINT qualification, client concerns, and strategic questions for the advisor to ask.

## 📊 Features Overview

### Real-Time Intelligence Dashboard
- **Consultation Summary**: Key developments as they happen
- **FAINT Qualification**: Financial capacity and decision-making assessment
- **Client Information**: Personal and financial background details
- **Advisor Reminders**: AI-generated coaching suggestions
- **Client Concerns**: Identified worries with addressing strategies
- **Strategic Questions**: Specific questions to gather more valuable information

### Advanced AI Analysis
- **Claude 3.5 Sonnet**: State-of-the-art conversation understanding
- **AssemblyAI Universal Streaming v3**: Ultra-low latency transcription (50ms)
- **FAINT Framework**: Financial industry standard qualification method
- **Tool-based Updates**: Structured data extraction for reliable insights

### Data Persistence
- **Live Logs**: Real-time conversation tracking in `./consultation_logs/`
- **Final Reports**: Comprehensive analysis with full transcripts
- **JSON Format**: Easy integration with other systems and databases

## 🛠️ Technical Architecture

- **Audio Processing**: 100ms buffered chunks for optimal streaming performance
- **WebSocket Streaming**: Direct connection to AssemblyAI v3 API
- **AI Pipeline**: Real-time transcript → Claude analysis → Structured insights
- **Error Handling**: Robust cleanup and graceful shutdown procedures
- **Resource Management**: Automatic buffer management and connection cleanup

## 📁 Output Files

The system generates:
- `consultation_logs/{meeting_id}.json` - Live conversation data
- `consultation_logs/{meeting_id}_final_report.json` - Complete analysis report

## 🔒 Security & Privacy

- All audio processing happens in real-time (no persistent audio storage)
- Conversation logs are stored locally
- API keys are managed through environment variables
- Compliance with financial consultation privacy requirements

This system transforms traditional financial consultations into data-driven, AI-enhanced experiences that help advisors provide better service while ensuring no critical information is missed.