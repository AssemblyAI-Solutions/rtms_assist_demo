# RTMS Financial Consultation Intelligence - Node.js

> 🧠 This demo was presented at the **Zoom Developer Summit 2025**.

This project demonstrates how to build an AI-powered financial consultation assistant using Zoom's RTMS (Real-Time Media Streaming) with AssemblyAI's Universal Streaming v3 and Anthropic's Claude for real-time conversation analysis.

## 🎯 What This System Does

This intelligent assistant monitors financial consultation conversations in real-time and provides:

- **📝 Live Transcription**: Real-time speech-to-text using AssemblyAI's latest Universal Streaming v3 model with speaker identification
- **💎 FAINT Qualification**: Tracks Funds, Authority, Interest, Need, and Timing throughout the conversation
- **🧠 Smart Analysis**: Uses Claude AI to extract key insights and identify opportunities
- **💡 Advisor Coaching**: Real-time suggestions and reminders for financial advisors
- **⚠️ Concern Detection**: Identifies client worries and suggests addressing strategies
- **❓ Strategic Questions**: AI-generated questions to gather more valuable information

## 🌐 Web Interface Features

### Dual-Tab Dashboard
- **📊 Financial Intelligence Tab**: Live FAINT analysis, client insights, and advisor recommendations
- **📝 Live Transcript Tab**: Real-time conversation transcript with speaker labels and timestamps

> [!TIP]
> **Important UI Usage Notes:**
> - **Pause refresh when changing speaker labels** to prevent interruption during role assignment
> - **Pause refresh when expanding "Show All" sections** to avoid UI state conflicts
> - **Use the ⏸️ Pause button** next to the update interval control for stable interaction with dropdown menus and expandable sections

### Data Management
- **📝 Running Lists**: Client information, consultation summary, and other data types maintain historical records
- **🔒 Data Preservation**: Existing FAINT qualification data is preserved unless new information is detected
- **📊 Smart Updates**: AI only updates fields with genuinely new or changed information
- **🗂️ Collapsible History**: View latest items by default, expand to see full history when needed

## 🏗️ Setup

### Prerequisites
- Node.js 18+ 
- Zoom account with RTMS enabled
- Zoom App SDK integration (for in-meeting access)
- AssemblyAI API key
- Anthropic API key
- ffmpeg (for audio processing)
- ngrok or similar tunneling service for development

### Zoom App Configuration

#### 1. Create a Zoom App
For detailed information on setting up Zoom RTMS Apps, go to their [documentation](https://developers.zoom.us/docs/rtms/).

1. Go to [Zoom Marketplace](https://marketplace.zoom.us/) and create a new app
2. Choose "General App" type
3. Fill in basic app information

#### 2. Configure App Features
Under the **App Features** section:

**Zoom App SDK:**
- Click the **+ Add APIs** button and enable the following options:
  - **APIs**: `shareApp`
  
**Scopes:**
- Ensure that the following scope is selected on the **Scopes** tab:
  - `zoomapp:inmeeting`

#### 3. RTMS Configuration
1. Enable **Real-Time Media Streaming (RTMS)**
2. Configure webhook URL: `https://your-domain.com/webhook`
3. Enable webhook events:
   - `meeting.rtms_started`
   - `meeting.rtms_stopped`
   - `endpoint.url_validation`

#### 4. App URLs
Configure the following URLs in your Zoom App:
- **Home URL**: `https://your-domain.com/`
- **Redirect URL**: `https://your-domain.com/`

### Installation

```bash
git clone https://github.com/AssemblyAI-Solutions/rtms_assist_demo.git
cd rtms_assist_demo
npm install
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

# Development (optional)
NODE_ENV=development
DEBUG_MODE=false
PORT=8080
```

3. **Set up ngrok for development**:
```bash
# Install ngrok globally
npm install -g ngrok

# Start your app
npm start

# In another terminal, expose your app
ngrok http 8080
```

4. **Update Zoom App URLs**:
   - Use your ngrok URL (e.g., `https://abc123.ngrok.io`) for all webhook and app URLs in the Zoom Marketplace configuration

## 🚀 Usage

### Start the System
```bash
npm start
```

The system will start on port 8080 and display:
```
🌐 Financial Consultation Intelligence System running at http://localhost:8080
🔗 Webhook endpoint at http://localhost:8080/webhook
🐛 Debug mode: ENABLED/DISABLED
📋 UI UPDATES: Client info as running list, configurable intervals with pause/resume
```

### Access the Dashboard
- **Direct Access**: Open `http://localhost:8080` in your browser
- **In-Meeting Access**: Open the app from within a Zoom meeting using the Apps panel

### Dashboard Controls

#### Update Interval Configuration
- **Default Interval**: 3000ms (3 seconds)
- **Adjustable Range**: 500ms to 30000ms
- **Settings Persistence**: Interval preferences saved in browser localStorage
- **Real-Time Changes**: New interval applied immediately

#### Pause/Resume Functionality
- **⏸️ Pause Button**: Located next to update interval control
- **When to Use Pause**:
  - Before changing speaker role assignments
  - When expanding "Show All" sections
  - During detailed data review
  - To prevent UI interruptions during interactions
- **Visual Feedback**: Button changes to "▶️ Resume" when paused
- **Status Display**: Pause state shown in all status messages

### Start a Consultation
1. **Join/Start a Zoom meeting**
2. **Open the app** from the Zoom Apps panel (📱 Apps button in meeting toolbar)
3. **Enable RTMS** if prompted
4. The dashboard will automatically switch to "🟢 ACTIVE" status
5. **Pause refresh** using the ⏸️ button before assigning speaker roles
6. **Assign speaker roles** using the Speaker Assignment controls
7. **Resume refresh** to continue monitoring
8. Watch real-time transcription and AI analysis appear in both tabs
9. Monitor financial insights as the conversation progresses

### Speaker Management
- **Auto-Detection**: System automatically detects when new speakers join
- **Role Assignment**: Use dropdown controls to assign "Consultant" or "Client" roles
- **⚠️ Best Practice**: Always pause refresh before changing speaker assignments
- **Real-Time Updates**: Transcript labels update immediately when roles are changed
- **Solo Testing**: First detected speaker is automatically assigned as "Consultant"

## 🎭 System Flow

1. **🎧 Zoom Connection**: Direct WebSocket connection to Zoom RTMS (no SDK required for audio)
2. **👥 Speaker Detection**: Automatic speaker identification using Zoom's user_id system
3. **🎙️ Audio Streaming**: Base64-decoded audio chunks sent to AssemblyAI 
4. **📝 Real-Time Transcription**: AssemblyAI v3 provides ultra-low latency speech-to-text 
5. **🤖 AI Analysis**: Claude 3.5 Sonnet analyzes each transcript segment for financial insights
6. **🔒 Data Preservation**: Smart updates that preserve existing information unless new data is detected
7. **📊 Live Updates**: Web dashboard refreshes at user-configurable intervals (default 3000ms)
8. **💾 Data Persistence**: Conversation logs and final reports saved to `./consultation_logs/`

## 📊 AI Analysis Features

### FAINT Qualification Framework
- **💰 Funds**: Financial capacity and assets identification
- **👤 Authority**: Decision-making power assessment  
- **🎯 Interest**: Engagement and investment appetite
- **🎪 Need**: Financial goals and problems identification
- **⏰ Timing**: Timeline for financial decisions
- **🔒 Data Preservation**: Existing FAINT data retained unless new information is detected

### Smart Coaching
- **Consultation Summary**: Key developments extracted automatically (running list)
- **Client Information**: Personal and financial background compilation (running list)
- **Advisor Reminders**: AI-generated coaching suggestions (running list)
- **Client Concerns**: Worry identification with addressing strategies (running list)
- **Strategic Questions**: Specific questions to gather valuable information (running list)

### Webhook Endpoints
- `POST /webhook` - Zoom RTMS webhook handler. MUST BE SET TO CATCH RTMS WEBHOOK

## 📁 Output Files

The system generates structured JSON files:
- `consultation_logs/{meeting_id}.json` - Live conversation tracking with preserved data
- `consultation_logs/{meeting_id}_final_report.json` - Complete analysis with full transcript and speaker mapping
