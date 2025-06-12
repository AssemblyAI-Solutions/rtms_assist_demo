import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import querystring from "querystring";
import { AssemblyAI } from "assemblyai";
import Anthropic from "@anthropic-ai/sdk";
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

// Zoom RTMS credentials
const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN;
const CLIENT_ID = process.env.ZM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZM_CLIENT_SECRET;

// Audio stream options
const AUDIO_MULTI_STREAMS = 1;  // Individual participant streams
const AUDIO_MIXED_STREAM = 0;   // Single mixed stream

// CORRECTED: Audio parameter constants based on documentation
const AUDIO_SAMPLE_RATES = {
    SR_8K: 0,
    SR_16K: 1,
    SR_32K: 2,
    SR_48K: 3
};

const AUDIO_CHANNELS = {
    MONO: 1,      
    STEREO: 2
};

const AUDIO_CODECS = {
    L16: 1,       
    G711: 2,
    G722: 3,
    OPUS: 4
};

const MEDIA_CONTENT_TYPES = {
    RAW_AUDIO: 2, 
};

const MEDIA_DATA_OPTIONS = {
    AUDIO_MIXED_STREAM: 1,
    AUDIO_MULTI_STREAMS: 2,  
};

// Performance optimization: reduce debug logging
const DEBUG_ENABLED = process.env.DEBUG_MODE === 'true';

// Financial Consultation Analysis Setup
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Store conversation data
let conversationHistory = [];
let conversationId = null;
let financialData = {
  summary: [],
  faint: {
    funds: "Not identified",
    authority: "Not identified", 
    interest: "Not identified",
    need: "Not identified",
    timing: "Not identified"
  },
  clientInfo: [],
  advisorReminders: [],
  concerns: [],
  strategicQuestions: []
};

// Global transcript storage
global.liveTranscripts = [];

// Enhanced speaker tracking with detailed logging
const speakerTracking = {
  detectedUsers: new Map(), 
  speakerTransitions: [], 
  debugMode: DEBUG_ENABLED
};

// Speaker management
const speakerMapping = new Map(); 
const detectedSpeakers = new Set(); 
let currentSpeakerId = null;
let lastTranscriptSpeaker = null;

// Audio streaming configuration (optimized chunk sizes)
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const TARGET_CHUNK_DURATION_MS = 250; // Increased for better performance
const TARGET_CHUNK_SIZE = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * TARGET_CHUNK_DURATION_MS) / 1000;

// Keep track of active connections and audio collectors per meeting
const activeConnections = new Map();
const audioCollectors = new Map();

// AssemblyAI v3 Streaming Configuration
const CONNECTION_PARAMS = {
  sample_rate: SAMPLE_RATE,
  format_turns: true,
};
const API_ENDPOINT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";
const API_ENDPOINT = `${API_ENDPOINT_BASE_URL}?${querystring.stringify(CONNECTION_PARAMS)}`;

// Initialize Express app
const app = express();
const PORT = 8080;

// Optimized helmet configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year in seconds
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: {
    policy: "strict-origin-when-cross-origin"
  }
}));

// Regular middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.raw({type: 'application/json'}));

// Optimized speaker event logging (only when debug enabled)
function logSpeakerEvent(event, data) {
  if (!DEBUG_ENABLED) return;
  
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event,
    data,
    currentSpeaker: currentSpeakerId,
    totalDetectedUsers: speakerTracking.detectedUsers.size
  };
  
  console.log(`🎤 ${event}: Speaker ${data.speakerId || currentSpeakerId}`);
  
  speakerTracking.speakerTransitions.push(logEntry);
  
  // Keep only last 50 events for memory efficiency
  if (speakerTracking.speakerTransitions.length > 50) {
    speakerTracking.speakerTransitions = speakerTracking.speakerTransitions.slice(-25);
  }
}

// Optimized Financial Consultation Tools (reduced descriptions for faster processing)
const TOOLS = [
  {
    name: "update_summary",
    description: "Add a new bullet point to the consultation summary.",
    input_schema: {
      type: "object",
      properties: {
        new_point: {
          type: "string",
          description: "A single new bullet point"
        }
      },
      required: ["new_point"]
    }
  },
  {
    name: "update_faint",
    description: "Update specific FAINT qualification fields. Only provide fields that have new/updated information.",
    input_schema: {
      type: "object",
      properties: {
        funds: { type: "string", description: "Financial capacity info" },
        authority: { type: "string", description: "Decision-making authority" },
        interest: { type: "string", description: "Investment interest level" },
        need: { type: "string", description: "Financial needs/goals" },
        timing: { type: "string", description: "Timeline for decisions" }
      },
      required: []
    }
  },
  {
    name: "update_client_info",
    description: "Add client information.",
    input_schema: {
      type: "object",
      properties: {
        new_info: { type: "string", description: "New client information" }
      },
      required: ["new_info"]
    }
  },
  {
    name: "update_advisor_reminders",
    description: "Add advisor reminder.",
    input_schema: {
      type: "object",
      properties: {
        new_reminder: { type: "string", description: "Reminder for advisor" }
      },
      required: ["new_reminder"]
    }
  },
  {
    name: "update_concerns",
    description: "Add client concern.",
    input_schema: {
      type: "object",
      properties: {
        new_concern: {
          type: "object",
          properties: {
            concern: { type: "string", description: "Client concern" },
            addressing_strategy: { type: "string", description: "How to address it" }
          },
          required: ["concern", "addressing_strategy"]
        }
      },
      required: ["new_concern"]
    }
  },
  {
    name: "update_strategic_questions",
    description: "Add strategic question.",
    input_schema: {
      type: "object",
      properties: {
        new_question: {
          type: "object",
          properties: {
            question: { type: "string", description: "Question to ask" },
            purpose: { type: "string", description: "Why ask this" }
          },
          required: ["question", "purpose"]
        }
      },
      required: ["new_question"]
    }
  }
];

// Dashboard route with configurable update interval, pause button, and collapsible sections
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Financial Consultation Intelligence System</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: #333;
                height: 100vh;
                overflow: hidden;
            }
            
            .container {
                height: 100vh;
                display: flex;
                flex-direction: column;
                max-width: 1400px;
                margin: 0 auto;
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(10px);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            }
            
            .header {
                background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
                color: white;
                padding: 20px 30px;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            }
            
            .header h1 {
                font-size: 1.8em;
                font-weight: 600;
                text-align: center;
                margin: 0;
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            }
            
            .status-bar {
                background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
                color: white;
                padding: 12px 30px;
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                gap: 20px;
                font-size: 0.9em;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }
            
            .status-item {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .status-label {
                opacity: 0.8;
            }
            
            .status-value {
                font-weight: 600;
            }
            
            .update-interval-control {
                display: flex;
                align-items: center;
                gap: 8px;
                background: rgba(255, 255, 255, 0.1);
                padding: 6px 12px;
                border-radius: 6px;
                border: 1px solid rgba(255, 255, 255, 0.2);
            }
            
            .update-interval-input {
                width: 60px;
                padding: 4px 6px;
                border: 1px solid rgba(255, 255, 255, 0.3);
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.9);
                color: #333;
                font-size: 0.85em;
                text-align: center;
            }
            
            .update-interval-unit {
                font-size: 0.8em;
                opacity: 0.8;
            }
            
            .pause-button {
                padding: 4px 8px;
                border: 1px solid rgba(255, 255, 255, 0.3);
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.9);
                color: #333;
                font-size: 0.8em;
                cursor: pointer;
                transition: all 0.2s ease;
                font-weight: 500;
            }
            
            .pause-button:hover {
                background: rgba(255, 255, 255, 1);
                transform: translateY(-1px);
            }
            
            .pause-button.paused {
                background: #dc3545;
                color: white;
                border-color: #dc3545;
            }
            
            .tabs {
                display: flex;
                background: #f8f9fa;
                border-bottom: 2px solid #e9ecef;
            }
            
            .tab {
                flex: 1;
                padding: 16px 24px;
                text-align: center;
                cursor: pointer;
                background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
                border-right: 1px solid #dee2e6;
                transition: all 0.3s ease;
                font-weight: 500;
                color: #495057;
            }
            
            .tab:last-child {
                border-right: none;
            }
            
            .tab.active {
                background: linear-gradient(135deg, #007bff 0%, #0056b3 100%);
                color: white;
                box-shadow: 0 2px 8px rgba(0, 123, 255, 0.3);
            }
            
            .tab:hover:not(.active) {
                background: linear-gradient(135deg, #e9ecef 0%, #dee2e6 100%);
                transform: translateY(-1px);
            }
            
            .tab-content {
                display: none;
                flex: 1;
                overflow: hidden;
            }
            
            .tab-content.active {
                display: flex;
                flex-direction: column;
            }
            
            .dashboard-container {
                flex: 1;
                overflow-y: auto;
                padding: 24px;
                background: #f8f9fa;
            }
            
            .speaker-controls {
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
                border: 1px solid #e9ecef;
            }
            
            .speaker-controls h3 {
                margin-bottom: 15px;
                color: #2c3e50;
                font-size: 1.1em;
            }
            
            .speaker-list {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 15px;
            }
            
            .speaker-item {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 15px;
                background: #f8f9fa;
                border-radius: 8px;
                border: 1px solid #e9ecef;
                transition: all 0.2s ease;
            }
            
            .speaker-item.active {
                border-color: #28a745;
                background: #d4edda;
                box-shadow: 0 2px 8px rgba(40, 167, 69, 0.2);
            }
            
            .speaker-info {
                display: flex;
                flex-direction: column;
                gap: 5px;
            }
            
            .speaker-id {
                font-weight: bold;
                color: #2c3e50;
            }
            
            .speaker-status {
                font-size: 0.85em;
                color: #28a745;
                font-weight: 500;
            }
            
            .speaker-select {
                padding: 8px 12px;
                border: 1px solid #ddd;
                border-radius: 6px;
                background: white;
                font-size: 0.9em;
                min-width: 120px;
            }
            
            .dashboard-section {
                background: white;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
                border: 1px solid #e9ecef;
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }
            
            .dashboard-section:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
            }
            
            .section-title {
                font-size: 1.1em;
                font-weight: 600;
                color: #2c3e50;
                margin-bottom: 16px;
                padding-bottom: 8px;
                border-bottom: 2px solid #e9ecef;
                display: flex;
                align-items: center;
                gap: 8px;
                justify-content: space-between;
            }
            
            .section-title-left {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .expand-button {
                background: #f8f9fa;
                border: 1px solid #dee2e6;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 0.8em;
                cursor: pointer;
                transition: all 0.2s ease;
                color: #495057;
                font-weight: 500;
            }
            
            .expand-button:hover {
                background: #e9ecef;
                border-color: #adb5bd;
            }
            
            .expand-button.expanded {
                background: #007bff;
                border-color: #007bff;
                color: white;
            }
            
            .item-count {
                background: #6c757d;
                color: white;
                border-radius: 12px;
                padding: 2px 8px;
                font-size: 0.75em;
                font-weight: 600;
                margin-left: 8px;
            }
            
            .faint-grid {
                display: grid;
                grid-template-columns: 120px 1fr;
                gap: 12px 20px;
                align-items: start;
            }
            
            .faint-label {
                font-weight: 600;
                color: #495057;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            
            .faint-value {
                color: #2c3e50;
                padding: 8px 12px;
                background: #f8f9fa;
                border-radius: 6px;
                border-left: 3px solid #007bff;
            }
            
            .list-item {
                margin: 8px 0;
                padding: 12px 16px;
                background: #f8f9fa;
                border-radius: 8px;
                border-left: 4px solid #28a745;
                color: #2c3e50;
                line-height: 1.5;
            }
            
            .list-item.latest {
                border-left-color: #007bff;
                background: linear-gradient(135deg, #e7f3ff 0%, #f0f8ff 100%);
                box-shadow: 0 2px 8px rgba(0, 123, 255, 0.15);
            }
            
            .concern-item {
                margin: 12px 0;
                padding: 16px;
                background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 20%);
                border-radius: 8px;
                border-left: 4px solid #e53e3e;
            }
            
            .concern-item.latest {
                border-left-color: #dc3545;
                background: linear-gradient(135deg, #f8d7da 0%, #f5c6cb 20%);
                box-shadow: 0 2px 8px rgba(220, 53, 69, 0.15);
            }
            
            .concern-item strong {
                color: #c53030;
            }
            
            .question-item {
                margin: 12px 0;
                padding: 16px;
                background: linear-gradient(135deg, #ebf8ff 0%, #bee3f8 20%);
                border-radius: 8px;
                border-left: 4px solid #3182ce;
            }
            
            .question-item.latest {
                border-left-color: #0056b3;
                background: linear-gradient(135deg, #cce7ff 0%, #b3d9ff 20%);
                box-shadow: 0 2px 8px rgba(0, 86, 179, 0.15);
            }
            
            .question-item strong {
                color: #2b6cb0;
            }
            
            .expanded-items {
                display: none;
            }
            
            .expanded-items.show {
                display: block;
            }
            
            .transcript-container {
                flex: 1;
                background: #1a202c;
                color: #e2e8f0;
                font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
                padding: 20px;
                overflow-y: auto;
                margin: 0;
            }
            
            .transcript-entry {
                margin: 8px 0;
                padding: 12px 16px;
                border-left: 3px solid #4fd1c7;
                background: rgba(79, 209, 199, 0.1);
                border-radius: 0 8px 8px 0;
                transition: all 0.2s ease;
                line-height: 1.6;
            }
            
            .transcript-entry:hover {
                background: rgba(79, 209, 199, 0.15);
                transform: translateX(4px);
            }
            
            .transcript-entry.consultant {
                border-left-color: #fbbf24;
                background: rgba(251, 191, 36, 0.1);
            }
            
            .transcript-entry.client {
                border-left-color: #60a5fa;
                background: rgba(96, 165, 250, 0.1);
            }
            
            .transcript-timestamp {
                color: #4fd1c7;
                font-size: 0.85em;
                margin-bottom: 6px;
                font-weight: 600;
                font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
            }
            
            .transcript-text {
                color: #e2e8f0;
                line-height: 1.6;
                white-space: pre-wrap;
                word-wrap: break-word;
            }
            
            .speaker-label {
                font-weight: bold;
                margin-right: 8px;
            }
            
            .speaker-label.consultant {
                color: #fbbf24;
            }
            
            .speaker-label.client {
                color: #60a5fa;
            }
            
            .status-active {
                color: #28a745;
                font-weight: 600;
            }
            
            .status-inactive {
                color: #dc3545;
                font-weight: 600;
            }
            
            .empty-state {
                text-align: center;
                color: #6c757d;
                font-style: italic;
                padding: 60px 20px;
                background: white;
                border-radius: 12px;
                box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
            }
            
            .empty-state-transcript {
                text-align: center;
                color: #a0aec0;
                font-style: italic;
                padding: 60px 20px;
                height: 100%;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
            }
            
            .pulse {
                animation: pulse 2s infinite;
            }
            
            @keyframes pulse {
                0% { opacity: 1; }
                50% { opacity: 0.5; }
                100% { opacity: 1; }
            }
            
            .debug-info {
                background: #f1f3f4;
                border: 1px solid #dadce0;
                border-radius: 8px;
                padding: 10px;
                margin-top: 10px;
                font-size: 0.8em;
                color: #5f6368;
            }
            
            .debug-links {
                margin-top: 10px;
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
            }
            
            .debug-link {
                background: #007bff;
                color: white;
                padding: 5px 10px;
                border-radius: 4px;
                text-decoration: none;
                font-size: 0.8em;
                transition: background 0.2s;
            }
            
            .debug-link:hover {
                background: #0056b3;
                color: white;
            }
            
            /* Custom scrollbar */
            ::-webkit-scrollbar {
                width: 8px;
            }
            
            ::-webkit-scrollbar-track {
                background: #f1f1f1;
                border-radius: 4px;
            }
            
            ::-webkit-scrollbar-thumb {
                background: #c1c1c1;
                border-radius: 4px;
            }
            
            ::-webkit-scrollbar-thumb:hover {
                background: #a8a8a8;
            }
            
            .transcript-container::-webkit-scrollbar-track {
                background: #2d3748;
            }
            
            .transcript-container::-webkit-scrollbar-thumb {
                background: #4a5568;
            }
            
            .transcript-container::-webkit-scrollbar-thumb:hover {
                background: #718096;
            }
            
            @media (max-width: 768px) {
                .status-bar {
                    grid-template-columns: 1fr;
                    gap: 10px;
                }
                
                .faint-grid {
                    grid-template-columns: 1fr;
                    gap: 8px;
                }
                
                .dashboard-container {
                    padding: 16px;
                }
                
                .header h1 {
                    font-size: 1.4em;
                }
                
                .speaker-list {
                    grid-template-columns: 1fr;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>💼 Financial Consultation Intelligence System</h1>
            </div>
            
            <div class="status-bar">
                <div class="status-item">
                    <span class="status-label">Status:</span>
                    <span id="system-status" class="status-value status-inactive">🔴 STANDBY</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Active Meetings:</span>
                    <span id="meeting-count" class="status-value">0</span>
                </div>
                <div class="status-item">
                    <span class="status-label">AI Analysis:</span>
                    <span id="ai-status" class="status-value status-inactive">❌ OFFLINE</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Last Update:</span>
                    <span id="last-update" class="status-value">Never</span>
                </div>
                <div class="status-item">
                    <div class="update-interval-control">
                        <span class="status-label">Update Every:</span>
                        <input type="number" id="update-interval" class="update-interval-input" value="3000" min="500" max="30000" step="500">
                        <span class="update-interval-unit">ms</span>
                        <button id="pause-button" class="pause-button">⏸️ Pause</button>
                    </div>
                </div>
            </div>

            <div class="tabs">
                <div class="tab active" data-tab="dashboard">
                    📊 Financial Intelligence Dashboard
                </div>
                <div class="tab" data-tab="transcript">
                    📝 Live Transcript
                </div>
            </div>

            <div id="dashboard-tab" class="tab-content active">
                <div class="dashboard-container">
                    <div id="speaker-controls" class="speaker-controls" style="display: none;">
                        <h3>👥 Speaker Assignment</h3>
                        <div id="speaker-list" class="speaker-list">
                            <!-- Speakers will be populated here -->
                        </div>
                        <div id="debug-info" class="debug-info" style="display: none;">
                            <!-- Debug information will appear here -->
                        </div>
                    </div>
                    
                    <div id="financial-dashboard">
                        <div class="empty-state">
                            <div class="pulse">💤</div>
                            <h3>Waiting for consultation to begin...</h3>
                            <p>Start a Zoom meeting with RTMS enabled to see live financial intelligence.</p>
                        </div>
                    </div>
                </div>
            </div>

            <div id="transcript-tab" class="tab-content">
                <div class="transcript-container" id="transcript-container">
                    <div class="empty-state-transcript">
                        <div class="pulse">🎙️</div>
                        <h3>Waiting for live transcription...</h3>
                        <p>Transcript will appear here when the consultation begins.</p>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let transcriptData = [];
            let isActiveCall = false;
            let debugMode = ${DEBUG_ENABLED};
            let updateInterval = 3000; // Default 3000ms
            let updateTimeoutId = null;
            let isPaused = false;

            // Enable debug mode by adding ?debug=1 to URL
            if (window.location.search.includes('debug=1')) {
                debugMode = true;
                console.log('🐛 Debug mode enabled');
            }

            // Load saved update interval from localStorage
            const savedInterval = localStorage.getItem('updateInterval');
            if (savedInterval) {
                updateInterval = parseInt(savedInterval);
                document.getElementById('update-interval').value = updateInterval;
            }

            // Handle update interval changes
            document.getElementById('update-interval').addEventListener('change', function() {
                const newInterval = parseInt(this.value);
                if (newInterval >= 500 && newInterval <= 30000) {
                    updateInterval = newInterval;
                    localStorage.setItem('updateInterval', updateInterval);
                    console.log(\`⏱️ Update interval changed to \${updateInterval}ms\`);
                    
                    // Restart the update cycle with new interval if not paused
                    if (!isPaused) {
                        if (updateTimeoutId) {
                            clearTimeout(updateTimeoutId);
                        }
                        scheduleUpdate();
                    }
                } else {
                    this.value = updateInterval; // Reset to valid value
                    alert('Update interval must be between 500ms and 30000ms');
                }
            });

            // Handle pause/resume button
            document.getElementById('pause-button').addEventListener('click', function() {
                if (isPaused) {
                    // Resume
                    isPaused = false;
                    this.textContent = '⏸️ Pause';
                    this.classList.remove('paused');
                    console.log('▶️ Updates resumed');
                    scheduleUpdate();
                } else {
                    // Pause
                    isPaused = true;
                    this.textContent = '▶️ Resume';
                    this.classList.add('paused');
                    console.log('⏸️ Updates paused');
                    if (updateTimeoutId) {
                        clearTimeout(updateTimeoutId);
                        updateTimeoutId = null;
                    }
                }
            });

            function showTab(tabName) {
                document.querySelectorAll('.tab-content').forEach(tab => {
                    tab.classList.remove('active');
                });
                document.querySelectorAll('.tab').forEach(tab => {
                    tab.classList.remove('active');
                });

                document.getElementById(tabName + '-tab').classList.add('active');
                document.querySelector(\`[data-tab="\${tabName}"]\`).classList.add('active');
            }

            function toggleExpand(sectionId) {
                const expandedItems = document.getElementById(\`\${sectionId}-expanded\`);
                const button = document.getElementById(\`\${sectionId}-expand-btn\`);
                
                if (expandedItems && button) {
                    const isExpanded = expandedItems.classList.contains('show');
                    
                    if (isExpanded) {
                        expandedItems.classList.remove('show');
                        button.textContent = 'Show All';
                        button.classList.remove('expanded');
                    } else {
                        expandedItems.classList.add('show');
                        button.textContent = 'Show Latest';
                        button.classList.add('expanded');
                    }
                }
            }

            async function updateSpeakers() {
                try {
                    const response = await fetch('/api/speakers');
                    const data = await response.json();
                    
                    if (debugMode) {
                        console.log('🐛 Speakers data:', data);
                        document.getElementById('debug-info').style.display = 'block';
                        
                        const pauseStatus = isPaused ? ' [PAUSED]' : '';
                        document.getElementById('debug-info').innerHTML = \`
                            <strong>Debug Info (Update: \${updateInterval}ms\${pauseStatus}):</strong><br>
                            Detected Speakers: \${JSON.stringify(data.speakers)}<br>
                            Current Speaker: \${data.currentSpeaker}<br>
                            <div class="debug-links">
                                <a href="/api/debug/speakers" target="_blank" class="debug-link">Basic Debug</a>
                                <a href="/api/debug/speakers/detailed" target="_blank" class="debug-link">Detailed Analysis</a>
                                <a href="/api/debug/speakers/export" class="debug-link">Export Logs</a>
                            </div>
                        \`;
                    }
                    
                    if (data.speakers && data.speakers.length > 0) {
                        document.getElementById('speaker-controls').style.display = 'block';
                        updateSpeakerControls(data.speakers);
                    } else {
                        document.getElementById('speaker-controls').style.display = 'none';
                    }
                } catch (error) {
                    console.error('Error updating speakers:', error);
                }
            }

            function updateSpeakerControls(speakers) {
                const speakerList = document.getElementById('speaker-list');
                
                speakerList.innerHTML = speakers.map(speaker => \`
                    <div class="speaker-item \${speaker.isActive ? 'active' : ''}">
                        <div class="speaker-info">
                            <div class="speaker-id">Speaker \${speaker.id}</div>
                            \${speaker.isActive ? '<div class="speaker-status">🎙️ Currently Speaking</div>' : ''}
                        </div>
                        <select class="speaker-select" data-speaker-id="\${speaker.id}">
                            <option value="Unassigned" \${speaker.role === 'Unassigned' ? 'selected' : ''}>Unassigned</option>
                            <option value="Consultant" \${speaker.role === 'Consultant' ? 'selected' : ''}>🏢 Consultant</option>
                            <option value="Client" \${speaker.role === 'Client' ? 'selected' : ''}>👤 Client</option>
                        </select>
                    </div>
                \`).join('');

                document.querySelectorAll('.speaker-select').forEach(select => {
                    select.addEventListener('change', function() {
                        const speakerId = this.getAttribute('data-speaker-id');
                        const role = this.value;
                        assignSpeaker(speakerId, role);
                    });
                });
            }

            async function assignSpeaker(speakerId, role) {
                try {
                    const response = await fetch('/api/speakers/assign', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ speakerId: parseInt(speakerId), role })
                    });
                    
                    if (response.ok) {
                        await updateSpeakers();
                        setTimeout(async () => {
                            await updateDashboard();
                        }, 100);
                    }
                } catch (error) {
                    console.error('❌ Error assigning speaker:', error);
                }
            }

            async function updateDashboard() {
                if (isPaused) return; // Skip updates when paused
                
                try {
                    const statusResponse = await fetch('/api/status');
                    const statusData = await statusResponse.json();
                    
                    document.getElementById('system-status').innerHTML = 
                        statusData.status === 'active' ? 
                        '<span class="status-active">🟢 ACTIVE</span>' : 
                        '<span class="status-inactive">🔴 STANDBY</span>';
                    
                    document.getElementById('meeting-count').textContent = statusData.active_meetings;
                    document.getElementById('ai-status').innerHTML = 
                        statusData.features.ai_analysis ? 
                        '<span class="status-active">✅ ONLINE</span>' : 
                        '<span class="status-inactive">❌ OFFLINE</span>';
                    
                    const now = new Date();
                    const pauseStatus = isPaused ? ' [PAUSED]' : '';
                    document.getElementById('last-update').textContent = 
                        \`\${now.toLocaleTimeString()} (\${updateInterval}ms\${pauseStatus})\`;

                    isActiveCall = statusData.status === 'active';

                    await updateSpeakers();

                    if (isActiveCall) {
                        const dashResponse = await fetch('/api/dashboard');
                        const dashData = await dashResponse.json();
                        updateFinancialDashboard(dashData.financial_data);
                        
                        const transcriptResponse = await fetch('/api/transcript');
                        const transcriptDataResponse = await transcriptResponse.json();
                        updateTranscript(transcriptDataResponse.transcripts || []);
                    } else {
                        const pauseStatusText = isPaused ? \` [Updates paused at \${updateInterval}ms intervals]\` : \` [Updating every \${updateInterval}ms]\`;
                        document.getElementById('financial-dashboard').innerHTML = \`
                            <div class="empty-state">
                                <div class="pulse">💤</div>
                                <h3>Waiting for consultation to begin...</h3>
                                <p>Start a Zoom meeting with RTMS enabled to see live financial intelligence.</p>
                                <p style="margin-top: 10px; font-size: 0.9em; opacity: 0.8;">\${pauseStatusText}</p>
                            </div>
                        \`;
                        
                        document.getElementById('transcript-container').innerHTML = \`
                            <div class="empty-state-transcript">
                                <div class="pulse">🎙️</div>
                                <h3>Waiting for live transcription...</h3>
                                <p>Transcript will appear here when the consultation begins.</p>
                                <p style="margin-top: 10px; font-size: 0.9em; opacity: 0.6;">\${pauseStatusText}</p>
                            </div>
                        \`;
                    }
                    
                } catch (error) {
                    console.error('Error updating dashboard:', error);
                }
            }

            function updateFinancialDashboard(data) {
                const dashboard = document.getElementById('financial-dashboard');
                
                // Helper function to create collapsible section
                function createCollapsibleSection(sectionId, title, items, renderItem, emptyMessage) {
                    if (!items || items.length === 0) {
                        return \`
                            <div class="dashboard-section">
                                <div class="section-title">
                                    <div class="section-title-left">\${title}</div>
                                </div>
                                <div style="color: #6c757d; font-style: italic; padding: 20px; text-align: center;">\${emptyMessage}</div>
                            </div>
                        \`;
                    }
                    
                    const hasMultiple = items.length > 1;
                    const latestItem = items[items.length - 1];
                    const olderItems = items.slice(0, -1);
                    
                    return \`
                        <div class="dashboard-section">
                            <div class="section-title">
                                <div class="section-title-left">
                                    \${title}
                                    <span class="item-count">\${items.length}</span>
                                </div>
                                \${hasMultiple ? \`<button class="expand-button" id="\${sectionId}-expand-btn" onclick="toggleExpand('\${sectionId}')">Show All</button>\` : ''}
                            </div>
                            
                            <!-- Latest item -->
                            \${renderItem(latestItem, items.length - 1, true)}
                            
                            <!-- Older items (hidden by default) -->
                            \${hasMultiple ? \`
                                <div class="expanded-items" id="\${sectionId}-expanded">
                                    \${olderItems.map((item, index) => renderItem(item, index, false)).join('')}
                                </div>
                            \` : ''}
                        </div>
                    \`;
                }
                
                dashboard.innerHTML = \`
                    <!-- FAINT Qualification moved to top -->
                    <div class="dashboard-section">
                        <div class="section-title">💎 FAINT Qualification</div>
                        <div class="faint-grid">
                            <div class="faint-label">💰 Funds:</div>
                            <div class="faint-value">\${data.faint?.funds || 'Not identified'}</div>
                            
                            <div class="faint-label">👤 Authority:</div>
                            <div class="faint-value">\${data.faint?.authority || 'Not identified'}</div>
                            
                            <div class="faint-label">🎯 Interest:</div>
                            <div class="faint-value">\${data.faint?.interest || 'Not identified'}</div>
                            
                            <div class="faint-label">🎪 Need:</div>
                            <div class="faint-value">\${data.faint?.need || 'Not identified'}</div>
                            
                            <div class="faint-label">⏰ Timing:</div>
                            <div class="faint-value">\${data.faint?.timing || 'Not identified'}</div>
                        </div>
                    </div>

                    \${createCollapsibleSection(
                        'clientInfo',
                        '👤 Client Information',
                        data.clientInfo,
                        (info, index, isLatest) => \`<div class="list-item \${isLatest ? 'latest' : ''}">\${index + 1}. \${info}</div>\`,
                        'No client information identified yet'
                    )}

                    \${createCollapsibleSection(
                        'summary',
                        '📝 Consultation Summary',
                        data.summary,
                        (point, index, isLatest) => \`<div class="list-item \${isLatest ? 'latest' : ''}">\${index + 1}. \${point}</div>\`,
                        'No key points identified yet'
                    )}

                    \${createCollapsibleSection(
                        'reminders',
                        '💡 Advisor Reminders',
                        data.advisorReminders,
                        (reminder, index, isLatest) => \`<div class="list-item \${isLatest ? 'latest' : ''}">\${index + 1}. \${reminder}</div>\`,
                        'No reminders yet'
                    )}

                    \${createCollapsibleSection(
                        'concerns',
                        '⚠️ Client Concerns & Addressing',
                        data.concerns,
                        (concern, index, isLatest) => \`
                            <div class="concern-item \${isLatest ? 'latest' : ''}">
                                <strong>Concern:</strong> \${concern.concern}<br><br>
                                <strong>Strategy:</strong> \${concern.addressing_strategy}
                            </div>
                        \`,
                        'No concerns identified yet'
                    )}

                    \${createCollapsibleSection(
                        'questions',
                        '❓ Strategic Questions to Ask',
                        data.strategicQuestions,
                        (question, index, isLatest) => \`
                            <div class="question-item \${isLatest ? 'latest' : ''}">
                                <strong>\${index + 1}. Question:</strong> "\${question.question}"<br><br>
                                <strong>Purpose:</strong> \${question.purpose}
                            </div>
                        \`,
                        'No strategic questions suggested yet'
                    )}
                \`;
            }

            function updateTranscript(transcripts) {
                const container = document.getElementById('transcript-container');
                
                if (!transcripts || transcripts.length === 0) {
                    const pauseStatus = isPaused ? ' [Updates paused]' : \` [Updating every \${updateInterval}ms]\`;
                    container.innerHTML = \`
                        <div class="empty-state-transcript">
                            <div class="pulse">🎙️</div>
                            <h3>No transcript data available yet...</h3>
                            <p>Transcription will appear here once the conversation begins.</p>
                            <p style="margin-top: 10px; font-size: 0.9em; opacity: 0.6;">\${pauseStatus}</p>
                        </div>
                    \`;
                    return;
                }
                
                const transcriptText = transcripts.map(entry => {
                    const speakerClass = entry.speaker ? entry.speaker.toLowerCase() : '';
                    const speakerIcon = entry.speaker === 'Consultant' ? '🏢' : entry.speaker === 'Client' ? '👤' : '🎙️';
                    
                    return \`
                        <div class="transcript-entry \${speakerClass}">
                            <div class="transcript-timestamp">[\${entry.timestamp}] \${speakerIcon} \${entry.speaker || 'Unknown'}</div>
                            <div class="transcript-text">\${entry.text.replace(/^(Consultant|Client): /, '')}</div>
                        </div>
                    \`;
                }).join('');
                
                container.innerHTML = transcriptText;
                container.scrollTop = container.scrollHeight;
            }

            // 🚀 CONFIGURABLE: Update scheduling with user-defined interval and pause functionality
            function scheduleUpdate() {
                if (isPaused) return; // Don't schedule if paused
                
                updateTimeoutId = setTimeout(() => {
                    if (!isPaused) { // Double-check pause state
                        updateDashboard().then(() => {
                            scheduleUpdate(); // Schedule next update
                        }).catch((error) => {
                            console.error('Update error:', error);
                            scheduleUpdate(); // Still schedule next update even if error
                        });
                    }
                }, updateInterval);
            }

            // Initial load
            updateDashboard();
            
            // Start the update cycle
            scheduleUpdate();

            // Add click event listeners for tabs
            document.addEventListener('DOMContentLoaded', function() {
                document.querySelectorAll('.tab').forEach(tab => {
                    tab.addEventListener('click', function() {
                        const tabName = this.getAttribute('data-tab');
                        showTab(tabName);
                    });
                });
            });

            // Cleanup on page unload
            window.addEventListener('beforeunload', function() {
                if (updateTimeoutId) {
                    clearTimeout(updateTimeoutId);
                }
            });
        </script>
    </body>
    </html>
  `);
});

// API endpoints (updated for client info as running list)
app.get('/api/transcript', (req, res) => {
  res.json({
    transcripts: global.liveTranscripts || [],
    conversation_id: conversationId,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/speakers', (req, res) => {
    const speakers = Array.from(detectedSpeakers).map(speakerId => ({
        id: speakerId,
        role: speakerMapping.get(speakerId) || 'Unassigned',
        isActive: currentSpeakerId === speakerId
    }));
    
    res.json({
        speakers,
        currentSpeaker: currentSpeakerId,
        timestamp: new Date().toISOString()
    });
});

app.post('/api/speakers/assign', (req, res) => {
    let { speakerId, role } = req.body;
    speakerId = parseInt(speakerId);
    
    if (!['Consultant', 'Client', 'Unassigned'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    
    if (!detectedSpeakers.has(speakerId)) {
        detectedSpeakers.add(speakerId);
    }
    
    speakerMapping.set(speakerId, role);
    if (speakerTracking.detectedUsers.has(speakerId)) {
        speakerTracking.detectedUsers.get(speakerId).role = role;
    }
    
    logSpeakerEvent('MANUAL_ROLE_ASSIGNMENT', {
        speakerId,
        newRole: role,
        assignedBy: 'user'
    });
    
    res.json({
        success: true,
        speakerId,
        role,
        message: `Speaker ${speakerId} assigned as ${role}`
    });
});

// Debug endpoints
app.get('/api/debug/speakers', (req, res) => {
    res.json({
        detectedSpeakers: Array.from(detectedSpeakers),
        speakerMapping: Array.from(speakerMapping.entries()),
        currentSpeakerId: currentSpeakerId,
        timestamp: new Date().toISOString(),
        recentTranscripts: global.liveTranscripts.slice(-5)
    });
});

app.get('/api/debug/speakers/detailed', (req, res) => {
    const testReport = {
        timestamp: new Date().toISOString(),
        summary: {
            totalDetectedUsers: speakerTracking.detectedUsers.size,
            currentActiveSpeaker: currentSpeakerId,
            totalSpeakerChanges: speakerTracking.speakerTransitions.length
        },
        detectedUsers: Array.from(speakerTracking.detectedUsers.entries()).map(([id, info]) => ({
            userId: id,
            assignedRole: speakerMapping.get(id) || 'Unassigned',
            firstDetected: new Date(info.firstSeen).toISOString(),
            lastActive: new Date(info.lastSeen).toISOString(),
            totalAudioChunks: info.audioChunks,
            isCurrentSpeaker: id === currentSpeakerId
        })),
        recentTransitions: speakerTracking.speakerTransitions.slice(-10)
    };
    
    res.json(testReport);
});

app.get('/api/debug/speakers/export', (req, res) => {
    const exportData = {
        timestamp: new Date().toISOString(),
        conversationId,
        speakerTransitions: speakerTracking.speakerTransitions,
        detectedUsers: Array.from(speakerTracking.detectedUsers.entries()),
        speakerMapping: Array.from(speakerMapping.entries()),
        transcripts: global.liveTranscripts
    };
    
    const filename = `speaker_debug_${conversationId || 'no_meeting'}_${Date.now()}.json`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
});

app.get('/api/status', (req, res) => {
  res.json({
    system: 'Financial Consultation Intelligence System',
    status: activeConnections.size > 0 ? 'active' : 'standby',
    conversation_id: conversationId,
    active_meetings: activeConnections.size,
    timestamp: new Date().toISOString(),
    features: {
      streaming_transcription: Array.from(audioCollectors.values()).some(c => c.streamingWs?.readyState === 1),
      ai_analysis: !!process.env.ANTHROPIC_API_KEY,
      zoom_connection: activeConnections.size > 0
    }
  });
});

app.get('/api/dashboard', (req, res) => {
  res.json({
    conversation_id: conversationId,
    financial_data: financialData,
    conversation_history_length: conversationHistory.length,
    active_meetings: activeConnections.size,
    timestamp: new Date().toISOString()
  });
});

// RTMS Webhook Handler
app.post('/webhook', (req, res) => {
    const { event, payload } = req.body;

    if (event === 'endpoint.url_validation' && payload?.plainToken) {
        const hash = crypto
            .createHmac('sha256', ZOOM_SECRET_TOKEN)
            .update(payload.plainToken)
            .digest('hex');
        return res.json({
            plainToken: payload.plainToken,
            encryptedToken: hash,
        });
    }

    if (event === 'meeting.rtms_started') {
        console.log('💼 STARTING FINANCIAL CONSULTATION ANALYSIS');
        const { meeting_uuid, rtms_stream_id, server_urls } = payload;
        
        // Initialize consultation
        conversationId = meeting_uuid.replace(/[^a-zA-Z0-9]/g, "_");
        conversationHistory = [];
        financialData = {
          summary: [],
          faint: {
            funds: "Not identified",
            authority: "Not identified", 
            interest: "Not identified",
            need: "Not identified",
            timing: "Not identified"
          },
          clientInfo: [],
          advisorReminders: [],
          concerns: [],
          strategicQuestions: []
        };
        
        // Reset speaker tracking
        speakerMapping.clear();
        detectedSpeakers.clear();
        speakerTracking.detectedUsers.clear();
        speakerTracking.speakerTransitions = [];
        currentSpeakerId = null;
        global.liveTranscripts = [];
        
        logSpeakerEvent('MEETING_STARTED', {
            meetingId: conversationId,
            streamId: rtms_stream_id
        });
        
        console.log(`📞 Meeting ID: ${conversationId}`);
        console.log('🤖 AI Assistant monitoring...');
        
        initializeAudioCollection(meeting_uuid);
        initializeAssemblyAIStreaming(meeting_uuid);
        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    if (event === 'meeting.rtms_stopped') {
        console.log('🏁 CONSULTATION ENDED');
        const { meeting_uuid } = payload;
        
        logSpeakerEvent('MEETING_ENDED', {
            meetingId: meeting_uuid,
            totalUsers: speakerTracking.detectedUsers.size,
            totalTransitions: speakerTracking.speakerTransitions.length
        });
        
        cleanupMeeting(meeting_uuid);
        displayCurrentFinancialData();
    }

    res.sendStatus(200);
});

// Audio Collection Management (unchanged from previous version)
function initializeAudioCollection(meetingUuid) {
    audioCollectors.set(meetingUuid, {
        audioChunks: [],
        audioBuffer: [],
        totalBytes: 0,
        chunkCount: 0,
        startTime: Date.now(),
        streamingWs: null,
        stopRequested: false
    });
}

function initializeAssemblyAIStreaming(meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector) return;

    console.log(`🔗 Connecting to AssemblyAI for ${meetingUuid}`);

    const streamingWs = new WebSocket(API_ENDPOINT, {
        headers: {
            Authorization: process.env.ASSEMBLYAI_API_KEY,
        },
    });

    collector.streamingWs = streamingWs;

    streamingWs.on('open', () => {
        console.log(`✅ AssemblyAI connected`);
    });

    streamingWs.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            await handleAssemblyAIMessage(data, meetingUuid);
        } catch (error) {
            console.error(`❌ AssemblyAI error: ${error}`);
        }
    });

    streamingWs.on('error', (error) => {
        console.error(`❌ AssemblyAI streaming error: ${error}`);
        collector.stopRequested = true;
    });

    streamingWs.on('close', (code, reason) => {
        if (DEBUG_ENABLED) console.log(`🔌 AssemblyAI closed: ${code}`);
    });
}

async function handleAssemblyAIMessage(data, meetingUuid) {
    const msgType = data.type;

    if (msgType === "Begin") {
        console.log(`🚀 Transcription session started`);
        global.liveTranscripts = [];
    } else if (msgType === "Turn") {
        const transcript = data.transcript || "";
        const formatted = data.turn_is_formatted;

        if (formatted && transcript.trim()) {
            const speakerRole = speakerMapping.get(currentSpeakerId) || `Speaker ${currentSpeakerId}`;
            const labeledTranscript = `${speakerRole}: ${transcript}`;
            
            global.liveTranscripts.push({
                timestamp: new Date().toLocaleTimeString(),
                text: labeledTranscript,
                speaker: speakerRole,
                speakerId: currentSpeakerId,
                type: 'final'
            });
            
            if (global.liveTranscripts.length > 50) {
                global.liveTranscripts = global.liveTranscripts.slice(-50);
            }
            
            console.log(`📝 [${speakerRole}] ${transcript}`);
            
            // Process transcript asynchronously for better performance
            processTranscript(labeledTranscript).catch(console.error);
        } else if (!formatted && transcript.trim()) {
            const speakerRole = speakerMapping.get(currentSpeakerId) || `Speaker ${currentSpeakerId}`;
            process.stdout.write(`\r🎙️ [${speakerRole}] ${transcript.substring(0, 80)}...`);
        }
    } else if (msgType === "Termination") {
        console.log(`\n🏁 Transcription session ended`);
    }
}

// Zoom RTMS Functions (unchanged from previous version)
function generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET) {
    const message = `${CLIENT_ID},${meetingUuid},${streamId}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
}

function connectToSignalingWebSocket(meetingUuid, streamId, serverUrl) {
    const ws = new WebSocket(serverUrl);

    if (!activeConnections.has(meetingUuid)) {
        activeConnections.set(meetingUuid, {});
    }
    activeConnections.get(meetingUuid).signaling = ws;

    ws.on('open', () => {
        console.log(`✅ Signaling connected`);
        const signature = generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET);

        const handshake = {
            msg_type: 1,
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            sequence: Math.floor(Math.random() * 1e9),
            signature,
            media_type: 1,
            media_params: {
                audio: {
                    data_opt: AUDIO_MULTI_STREAMS,
                }
            }
        };
        
        if (DEBUG_ENABLED) console.log('📤 Signaling handshake:', JSON.stringify(handshake, null, 2));
        ws.send(JSON.stringify(handshake));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (DEBUG_ENABLED) console.log('📨 Signaling:', JSON.stringify(msg, null, 2));

        if (msg.msg_type === 2 && msg.status_code === 0) {
            const mediaUrl = msg.media_server?.server_urls?.audio || msg.media_server?.server_urls?.all;
            if (mediaUrl) {
                connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, ws);
            }
        }

        if (msg.msg_type === 12) {
            ws.send(JSON.stringify({
                msg_type: 13,
                timestamp: msg.timestamp,
            }));
        }
    });

    ws.on('error', (err) => {
        console.error('❌ Signaling error:', err.message);
    });

    ws.on('close', () => {
        if (DEBUG_ENABLED) console.log('🔌 Signaling closed');
        if (activeConnections.has(meetingUuid)) {
            delete activeConnections.get(meetingUuid).signaling;
        }
    });
}

function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
    const mediaWs = new WebSocket(mediaUrl, { rejectUnauthorized: false });

    if (activeConnections.has(meetingUuid)) {
        activeConnections.get(meetingUuid).media = mediaWs;
    }

    mediaWs.on('open', () => {
        console.log(`✅ Media connected`);
        const signature = generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET);
        
        const handshake = {
            msg_type: 3,
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature,
            media_type: 1,
            payload_encryption: false,
            media_params: {
                audio: {
                    content_type: 2,
                    sample_rate: 1,
                    channel: 1,
                    codec: 1,
                    data_opt: 2,
                    send_rate: 100
                }
            }
        };
        
        if (DEBUG_ENABLED) console.log('📤 Media handshake:', JSON.stringify(handshake, null, 2));
        mediaWs.send(JSON.stringify(handshake));
    });

    mediaWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            // REMOVED: Excessive media message logging
            if (DEBUG_ENABLED && msg.msg_type !== 14) {
                console.log('📦 Media Message:', JSON.stringify(msg, null, 2));
            }

            if (msg.msg_type === 4) {
                if (msg.status_code === 0) {
                    signalingSocket.send(JSON.stringify({
                        msg_type: 7,
                        rtms_stream_id: streamId,
                    }));
                    console.log(`🚀 Multi-stream audio started`);
                    
                    if (msg.media_params?.audio?.data_opt !== undefined) {
                        const dataOpt = msg.media_params.audio.data_opt;
                        console.log(`🎤 Audio mode: ${dataOpt === 2 ? 'MULTI-STREAMS ✅' : 'MIXED ❌'}`);
                    }
                } else {
                    console.error(`❌ Media handshake failed: ${msg.status_code} - ${msg.reason}`);
                }
            }

            if (msg.msg_type === 12) {
                mediaWs.send(JSON.stringify({
                    msg_type: 13,
                    timestamp: msg.timestamp,
                }));
            }

            // OPTIMIZED: Audio data handling without excessive logging
            if (msg.msg_type === 14 && msg.content?.data) {
                const speakerId = msg.content.user_id !== undefined ? msg.content.user_id : 0;
                
                // Only log new users, not every audio packet
                if (!speakerTracking.detectedUsers.has(speakerId)) {
                    console.log(`🆔 New user detected: ${speakerId}`);
                }
                
                handleAudioDataWithSpeaker(msg.content.data, meetingUuid, speakerId);
            }

        } catch (err) {
            // Ignore non-JSON audio data packets silently
        }
    });

    mediaWs.on('error', (err) => {
        console.error('❌ Media error:', err.message);
    });

    mediaWs.on('close', () => {
        if (DEBUG_ENABLED) console.log('🔌 Media closed');
        if (activeConnections.has(meetingUuid)) {
            delete activeConnections.get(meetingUuid).media;
        }
    });
}

// OPTIMIZED: Speaker tracking with reduced logging
function handleAudioDataWithSpeaker(base64Data, meetingUuid, speakerId) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector || collector.stopRequested) return;

    const now = Date.now();
    
    // Enhanced user tracking
    if (!speakerTracking.detectedUsers.has(speakerId)) {
        speakerTracking.detectedUsers.set(speakerId, {
            firstSeen: now,
            lastSeen: now,
            audioChunks: 0,
            role: 'Unassigned'
        });
        
        logSpeakerEvent('NEW_USER_DETECTED', {
            speakerId,
            totalUsers: speakerTracking.detectedUsers.size,
            detectionOrder: Array.from(speakerTracking.detectedUsers.keys())
        });
        
        // Auto-assign roles
        if (speakerTracking.detectedUsers.size === 1) {
            speakerMapping.set(speakerId, 'Consultant');
            speakerTracking.detectedUsers.get(speakerId).role = 'Consultant';
            logSpeakerEvent('AUTO_ASSIGNED_CONSULTANT', { speakerId });
        } else if (speakerTracking.detectedUsers.size === 2) {
            speakerMapping.set(speakerId, 'Client');
            speakerTracking.detectedUsers.get(speakerId).role = 'Client';
            logSpeakerEvent('AUTO_ASSIGNED_CLIENT', { speakerId });
        }
        
        detectedSpeakers.add(speakerId);
    }
    
    // Update user activity
    const userInfo = speakerTracking.detectedUsers.get(speakerId);
    userInfo.lastSeen = now;
    userInfo.audioChunks++;

    // Track speaker changes
    if (currentSpeakerId !== speakerId) {
        const previousSpeaker = currentSpeakerId;
        currentSpeakerId = speakerId;
        
        logSpeakerEvent('SPEAKER_CHANGE', {
            from: { id: previousSpeaker, role: speakerMapping.get(previousSpeaker) },
            to: { id: speakerId, role: speakerMapping.get(speakerId) }
        });
    }

    // Process audio
    const audioBuffer = Buffer.from(base64Data, 'base64');
    collector.audioChunks.push(audioBuffer);
    collector.totalBytes += audioBuffer.length;
    collector.chunkCount++;

    sendToAssemblyAI(audioBuffer, meetingUuid);

    // REDUCED: Less frequent logging
    if (collector.chunkCount % 200 === 0) {
        const duration = (Date.now() - collector.startTime) / 1000;
        console.log(`📊 Audio: ${collector.chunkCount} chunks, ${(collector.totalBytes / 1024).toFixed(1)}KB, ${duration.toFixed(1)}s`);
    }
}

function sendToAssemblyAI(audioData, meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector || !collector.streamingWs || collector.stopRequested) return;

    collector.audioBuffer.push(audioData);
    
    const totalBufferedSize = collector.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    
    if (totalBufferedSize >= TARGET_CHUNK_SIZE) {
        const combinedBuffer = Buffer.concat(collector.audioBuffer);
        const chunkToSend = combinedBuffer.subarray(0, TARGET_CHUNK_SIZE);
        const remainingData = combinedBuffer.subarray(TARGET_CHUNK_SIZE);
        
        collector.audioBuffer = remainingData.length > 0 ? [remainingData] : [];
        
        if (collector.streamingWs.readyState === WebSocket.OPEN) {
            try {
                collector.streamingWs.send(chunkToSend);
            } catch (error) {
                console.error(`❌ Error sending to AssemblyAI: ${error.message}`);
            }
        }
    }
}

function flushAudioBuffer(meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector || collector.audioBuffer.length === 0) return;

    const combinedBuffer = Buffer.concat(collector.audioBuffer);
    const minChunkSize = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 50) / 1000;
    
    if (combinedBuffer.length >= minChunkSize && collector.streamingWs?.readyState === WebSocket.OPEN) {
        try {
            collector.streamingWs.send(combinedBuffer);
            console.log(`🔄 Flushed audio buffer`);
        } catch (error) {
            console.error(`❌ Error flushing: ${error.message}`);
        }
    }
    
    collector.audioBuffer = [];
}

async function cleanupMeeting(meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector) return;

    console.log(`🧹 Cleaning up meeting`);
    
    collector.stopRequested = true;
    flushAudioBuffer(meetingUuid);
    
    if (collector.streamingWs) {
        try {
            if (collector.streamingWs.readyState === WebSocket.OPEN) {
                collector.streamingWs.send(JSON.stringify({ type: "Terminate" }));
            }
            setTimeout(() => {
                if (collector.streamingWs) {
                    collector.streamingWs.close();
                }
            }, 1000);
        } catch (error) {
            console.error(`❌ Error closing AssemblyAI: ${error.message}`);
        }
    }

    if (activeConnections.has(meetingUuid)) {
        const connections = activeConnections.get(meetingUuid);
        for (const conn of Object.values(connections)) {
            if (conn && typeof conn.close === 'function') {
                conn.close();
            }
        }
        activeConnections.delete(meetingUuid);
    }

    if (collector.audioChunks.length > 0) {
        processRecordedAudio(meetingUuid, collector.audioChunks).catch(console.error);
    }

    audioCollectors.delete(meetingUuid);
}

// OPTIMIZED: Shorter system prompt for faster Claude processing
function getSystemPrompt() {
  return `Financial consultation analyst. Extract key financial information and provide advisor insights. Focus on FAINT qualification (Funds, Authority, Interest, Need, Timing), client concerns, and strategic questions. Be concise.

          IMPORTANT: When updating FAINT data, only include fields with NEW or CHANGED information. Do not include fields that haven't been mentioned or discussed. Preserve existing FAINT data.`;
}

async function executeToolAndGetResult(toolUse) {
  switch (toolUse.name) {
    case 'update_summary':
      financialData.summary.push(toolUse.input.new_point);
      if (DEBUG_ENABLED) console.log(`💰 Summary: ${toolUse.input.new_point}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Added"
      };
    case 'update_faint':
      // Only update fields that are provided and not empty
      Object.keys(toolUse.input).forEach(key => {
        if (toolUse.input[key] && toolUse.input[key].trim() !== '' && toolUse.input[key] !== 'Not identified') {
          financialData.faint[key] = toolUse.input[key];
        }
      });
      if (DEBUG_ENABLED) console.log(`💎 FAINT updated:`, toolUse.input);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Updated"
      };
    case 'update_client_info':
      financialData.clientInfo.push(toolUse.input.new_info);
      if (DEBUG_ENABLED) console.log(`👤 Client info: ${toolUse.input.new_info}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Added"
      };
    case 'update_advisor_reminders':
      financialData.advisorReminders.push(toolUse.input.new_reminder);
      if (DEBUG_ENABLED) console.log(`💡 Reminder: ${toolUse.input.new_reminder}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Added"
      };
    case 'update_concerns':
      financialData.concerns.push(toolUse.input.new_concern);
      if (DEBUG_ENABLED) console.log(`⚠️ Concern: ${toolUse.input.new_concern.concern}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Added"
      };
    case 'update_strategic_questions':
      financialData.strategicQuestions.push(toolUse.input.new_question);
      if (DEBUG_ENABLED) console.log(`❓ Question: ${toolUse.input.new_question.question}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Added"
      };
    default:
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Done"
      };
  }
}

// SIMPLIFIED: Financial display (only show when debug enabled)
function displayCurrentFinancialData() {
  if (!DEBUG_ENABLED) return;
  
  console.log('\n💼 FINANCIAL DASHBOARD UPDATE');
  console.log(`Summary points: ${financialData.summary.length}`);
  console.log(`FAINT data: ${Object.values(financialData.faint).filter(v => v !== "Not identified").length}/5`);
  console.log(`Client info items: ${financialData.clientInfo.length}`);
  console.log(`Reminders: ${financialData.advisorReminders.length}`);
  console.log(`Concerns: ${financialData.concerns.length}`);
  console.log(`Strategic questions: ${financialData.strategicQuestions.length}\n`);
}

// NEW: Function to validate and clean conversation history
function validateAndCleanHistory(history) {
  const cleaned = [];
  
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    
    // If this is a tool result message, make sure there's a corresponding tool use
    if (msg.role === "user" && Array.isArray(msg.content)) {
      // Check if previous message is assistant with tool_use
      const prevMsg = cleaned[cleaned.length - 1];
      if (prevMsg && prevMsg.role === "assistant" && Array.isArray(prevMsg.content)) {
        const hasToolUse = prevMsg.content.some(content => content.type === 'tool_use');
        if (hasToolUse) {
          // Valid tool result, include it
          cleaned.push(msg);
        }
        // Skip if no corresponding tool use
      }
      // Skip tool results without proper tool use
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Assistant message with tool use - always include
      cleaned.push(msg);
    } else if (typeof msg.content === "string" && msg.content.trim()) {
      // Regular text message - always include
      cleaned.push(msg);
    }
  }
  
  return cleaned;
}

// FIXED: Claude processing with proper conversation history management
async function processTranscript(transcript) {
  if (!transcript.trim()) return;
  
  try {
    const userMessage = {
      role: "user",
      content: transcript
    };
    conversationHistory.push(userMessage);

    // FIXED: Proper conversation history cleanup - preserve tool use/result pairs
    if (conversationHistory.length > 30) {
      // Find a safe truncation point that doesn't break tool pairs
      let safeStartIndex = 0;
      for (let i = conversationHistory.length - 20; i >= 0; i--) {
        const msg = conversationHistory[i];
        // Look for a user message that doesn't contain tool results
        if (msg.role === "user" && !Array.isArray(msg.content)) {
          safeStartIndex = i;
          break;
        }
      }
      conversationHistory = conversationHistory.slice(safeStartIndex);
    }

    // Filter out invalid messages more carefully
    const validHistory = conversationHistory.filter(msg => {
      if (Array.isArray(msg.content)) {
        return msg.content.length > 0;
      }
      return msg.content && msg.content.trim().length > 0;
    });

    // ADDITIONAL FIX: Validate conversation history for tool pairs
    const cleanHistory = validateAndCleanHistory(validHistory);

    let message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 512,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages: cleanHistory
    });

    // Process tool uses
    while (message.stop_reason === 'tool_use') {
      const toolResults = [];
      
      for (const content of message.content) {
        if (content.type === 'tool_use') {
          const result = await executeToolAndGetResult(content);
          toolResults.push(result);
        }
      }

      if (message.content && message.content.length > 0) {
        conversationHistory.push({
          role: "assistant",
          content: message.content
        });
      }

      if (toolResults.length > 0) {
        conversationHistory.push({
          role: "user",
          content: toolResults
        });
      }

      // Clean history again before next API call
      const validHistoryAfterTools = conversationHistory.filter(msg => {
        if (Array.isArray(msg.content)) {
          return msg.content.length > 0;
        }
        return msg.content && msg.content.trim().length > 0;
      });

      const cleanHistoryAfterTools = validateAndCleanHistory(validHistoryAfterTools);

      message = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 512,
        system: getSystemPrompt(),
        tools: TOOLS,
        messages: cleanHistoryAfterTools
      });
    }

    if (message.stop_reason !== 'tool_use' && message.content && message.content.length > 0) {
      conversationHistory.push({
        role: "assistant",
        content: message.content
      });
    }

    // Only save logs in debug mode
    if (DEBUG_ENABLED) {
      if (!fs.existsSync('./consultation_logs')) {
        fs.mkdirSync('./consultation_logs');
      }
      fs.writeFileSync(
        `./consultation_logs/${conversationId}.json`, 
        JSON.stringify({
          conversationHistory,
          financialData,
          timestamp: new Date().toISOString()
        }, null, 2)
      );
    }

  } catch (error) {
    console.error('❌ Claude processing error:', error.message);
    
    // FALLBACK: If there's still an error, reset conversation history
    if (error.message.includes('tool_use_id') || error.message.includes('tool_result')) {
      console.log('🔄 Resetting conversation history due to tool pairing error');
      conversationHistory = conversationHistory.filter(msg => 
        msg.role === "user" && typeof msg.content === "string"
      ).slice(-5); // Keep only last 5 simple user messages
    }
  }
}

async function processRecordedAudio(meetingId, audioChunks) {
  if (audioChunks.length === 0) {
    console.log("❌ No audio data");
    return;
  }

  const rawFilename = `recording_${meetingId}.raw`;
  const wavFilename = `recording_${meetingId}.wav`;

  try {
    const combinedBuffer = Buffer.concat(audioChunks);
    fs.writeFileSync(rawFilename, combinedBuffer);

    await convertRawToWav(rawFilename, wavFilename);
    console.log("🎵 WAV saved");

    if (DEBUG_ENABLED) {
      console.log("📄 Starting backup transcription...");
      
      const client = new AssemblyAI({
        apiKey: process.env.ASSEMBLYAI_API_KEY,
      });
      
      const transcript = await client.transcripts.transcribe({
        audio: wavFilename,
      });

      if (transcript.status === "error") {
        console.error(`❌ Backup transcription failed: ${transcript.error}`);
      } else {
        console.log("✅ Backup transcription completed");
        
        const finalReport = {
          meetingId,
          timestamp: new Date().toISOString(),
          financialData,
          speakerMapping: Array.from(speakerMapping.entries()),
          fullTranscript: transcript.text
        };
        
        fs.writeFileSync(
          `./consultation_logs/${meetingId}_final_report.json`, 
          JSON.stringify(finalReport, null, 2)
        );
      }
    }
  } catch (error) {
    console.error("❌ Audio processing error:", error.message);
  } finally {
    try {
      if (fs.existsSync(rawFilename)) fs.unlinkSync(rawFilename);
      if (fs.existsSync(wavFilename)) fs.unlinkSync(wavFilename);
    } catch (e) {
      console.error("❌ Cleanup error:", e.message);
    }
  }
}

async function convertRawToWav(rawFilename, wavFilename) {
  const command = `ffmpeg -y -f s16le -ar 16000 -ac 1 -i ${rawFilename} ${wavFilename}`;
  await execAsync(command);
  fs.unlinkSync(rawFilename);
}

// Start the server
const server = app.listen(PORT, () => {
  console.log(`🌐 Financial Consultation Intelligence System running at http://localhost:${PORT}`);
  console.log(`🔗 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`🐛 Debug mode: ${DEBUG_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  console.log('📋 UI UPDATES: Client info as running list, configurable intervals, pause button\n');
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  
  for (const [meetingId] of audioCollectors.entries()) {
    cleanupMeeting(meetingId);
  }
  
  setTimeout(() => process.exit(0), 1000);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Terminating...");
  
  for (const [meetingId] of audioCollectors.entries()) {
    cleanupMeeting(meetingId);
  }
  
  setTimeout(() => process.exit(0), 1000);
});

process.on("uncaughtException", (error) => {
  console.error(`\n❌ Uncaught exception: ${error.message}`);
  setTimeout(() => process.exit(1), 500);
});

console.log('\n💼 ZOOM FINANCIAL CONSULTATION INTELLIGENCE SYSTEM');
console.log('📋 ENHANCED UI: Client info as running list, configurable intervals with pause/resume');