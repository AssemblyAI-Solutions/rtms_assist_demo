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

// Debug log the environment variables
console.log('🔍 Environment Variables Check:');
console.log('ZOOM_SECRET_TOKEN:', ZOOM_SECRET_TOKEN ? '✅ Set' : '❌ Missing');
console.log('ZM_CLIENT_ID:', CLIENT_ID ? '✅ Set' : '❌ Missing');
console.log('ZM_CLIENT_SECRET:', CLIENT_SECRET ? '✅ Set' : '❌ Missing');
console.log('ASSEMBLYAI_API_KEY:', process.env.ASSEMBLYAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ Missing');
console.log('');

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
  clientInfo: "Not identified",
  advisorReminders: [],
  concerns: [],
  strategicQuestions: []
};

// Global transcript storage
global.liveTranscripts = [];

// Audio streaming configuration
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const TARGET_CHUNK_DURATION_MS = 100;
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

// Security middleware with helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
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
    maxAge: 31536000,
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

// Financial Consultation Tools
const TOOLS = [
  {
    name: "update_summary",
    description: "Add a new bullet point to the consultation summary when there's significant new financial information. Each bullet should be brief and concise. Only add a new bullet when there's meaningful new information to add.",
    input_schema: {
      type: "object",
      properties: {
        new_point: {
          type: "string",
          description: "A single new bullet point summarizing the latest significant financial development (without bullet symbol)"
        }
      },
      required: ["new_point"]
    }
  },
  {
    name: "update_faint",
    description: "Update the FAINT (Funds, Authority, Interest, Need, Timing) financial qualification assessment based on the consultation",
    input_schema: {
      type: "object",
      properties: {
        funds: {
          type: "string",
          description: "Identified financial capacity, assets, income, or investment capital information, or 'Not identified'"
        },
        authority: {
          type: "string",
          description: "Identified decision-making authority for financial decisions or 'Not identified'"
        },
        interest: {
          type: "string",
          description: "Identified level of interest in financial products/services or investment appetite, or 'Not identified'"
        },
        need: {
          type: "string",
          description: "Identified financial needs, goals, or problems to solve, or 'Not identified'"
        },
        timing: {
          type: "string",
          description: "Identified timeline for financial decisions or implementation, or 'Not identified'"
        }
      },
      required: ["funds", "authority", "interest", "need", "timing"]
    }
  },
  {
    name: "update_client_info",
    description: "Update information about the client when new personal or financial details are discovered.",
    input_schema: {
      type: "object",
      properties: {
        clientInfo: {
          type: "string",
          description: "Key information about the client's personal situation, family, career, or financial background."
        }
      },
      required: ["clientInfo"]
    }
  },
  {
    name: "update_advisor_reminders",
    description: "Add a new bullet point reminder when there's an important new suggestion for the financial advisor. Each reminder should be brief and actionable. Only add a new bullet when there's a meaningful new reminder.",
    input_schema: {
      type: "object",
      properties: {
        new_reminder: {
          type: "string",
          description: "A single new bullet point reminder for the advisor (without bullet symbol)"
        }
      },
      required: ["new_reminder"]
    }
  },
  {
    name: "update_concerns",
    description: "Add a new client concern and addressing strategy when a new worry or hesitation is identified. Only add when there's a clear new concern.",
    input_schema: {
      type: "object",
      properties: {
        new_concern: {
          type: "object",
          properties: {
            concern: {
              type: "string",
              description: "The new client concern or worry (brief)"
            },
            addressing_strategy: {
              type: "string",
              description: "Suggested approach to address this concern (brief)"
            }
          },
          required: ["concern", "addressing_strategy"]
        }
      },
      required: ["new_concern"]
    }
  },
  {
    name: "update_strategic_questions",
    description: "Add strategic questions the advisor should ask to gather more useful information about the client's financial situation, goals, or concerns. Only add when there are clear information gaps that specific questions could fill.",
    input_schema: {
      type: "object",
      properties: {
        new_question: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "A specific, actionable question the advisor should ask (brief)"
            },
            purpose: {
              type: "string",
              description: "Why this question would be valuable - what information it would reveal (brief)"
            }
          },
          required: ["question", "purpose"]
        }
      },
      required: ["new_question"]
    }
  }
];

// Single simplified dashboard route
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
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
            
            .concern-item {
                margin: 12px 0;
                padding: 16px;
                background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 20%);
                border-radius: 8px;
                border-left: 4px solid #e53e3e;
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
            
            .question-item strong {
                color: #2b6cb0;
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

          function showTab(tabName) {
              // Hide all tabs
              document.querySelectorAll('.tab-content').forEach(tab => {
                  tab.classList.remove('active');
              });
              document.querySelectorAll('.tab').forEach(tab => {
                  tab.classList.remove('active');
              });

              // Show selected tab
              document.getElementById(tabName + '-tab').classList.add('active');
              
              // Find and activate the clicked tab
              if (tabName === 'dashboard') {
                  document.querySelector('.tab:first-child').classList.add('active');
              } else if (tabName === 'transcript') {
                  document.querySelector('.tab:last-child').classList.add('active');
              }
          }

          async function updateDashboard() {
              try {
                  // Get system status
                  const statusResponse = await fetch('/api/status');
                  const statusData = await statusResponse.json();
                  
                  // Update status bar
                  document.getElementById('system-status').innerHTML = 
                      statusData.status === 'active' ? 
                      '<span class="status-active">🟢 ACTIVE</span>' : 
                      '<span class="status-inactive">🔴 STANDBY</span>';
                  
                  document.getElementById('meeting-count').textContent = statusData.active_meetings;
                  document.getElementById('ai-status').innerHTML = 
                      statusData.features.ai_analysis ? 
                      '<span class="status-active">✅ ONLINE</span>' : 
                      '<span class="status-inactive">❌ OFFLINE</span>';
                  
                  document.getElementById('last-update').textContent = 
                      new Date().toLocaleTimeString();

                  isActiveCall = statusData.status === 'active';

                  // Get financial data if call is active
                  if (isActiveCall) {
                      const dashResponse = await fetch('/api/dashboard');
                      const dashData = await dashResponse.json();
                      updateFinancialDashboard(dashData.financial_data);
                      
                      // Get transcript data
                      const transcriptResponse = await fetch('/api/transcript');
                      const transcriptDataResponse = await transcriptResponse.json();
                      updateTranscript(transcriptDataResponse.transcripts || []);
                  } else {
                      // Show waiting state
                      document.getElementById('financial-dashboard').innerHTML = \`
                          <div class="empty-state">
                              <div class="pulse">💤</div>
                              <h3>Waiting for consultation to begin...</h3>
                              <p>Start a Zoom meeting with RTMS enabled to see live financial intelligence.</p>
                          </div>
                      \`;
                      
                      document.getElementById('transcript-container').innerHTML = \`
                          <div class="empty-state-transcript">
                              <div class="pulse">🎙️</div>
                              <h3>Waiting for live transcription...</h3>
                              <p>Transcript will appear here when the consultation begins.</p>
                          </div>
                      \`;
                  }
                  
              } catch (error) {
                  console.error('Error updating dashboard:', error);
              }
          }

          function updateFinancialDashboard(data) {
              const dashboard = document.getElementById('financial-dashboard');
              
              dashboard.innerHTML = \`
                  <div class="dashboard-section">
                      <div class="section-title">📝 Consultation Summary</div>
                      \${data.summary && data.summary.length > 0 ? 
                          data.summary.map((point, i) => \`<div class="list-item">\${i + 1}. \${point}</div>\`).join('') :
                          '<div style="color: #6c757d; font-style: italic; padding: 20px; text-align: center;">No key points identified yet</div>'
                      }
                  </div>

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

                  <div class="dashboard-section">
                      <div class="section-title">👤 Client Information</div>
                      <div class="list-item">\${data.clientInfo || 'Not identified'}</div>
                  </div>

                  <div class="dashboard-section">
                      <div class="section-title">💡 Advisor Reminders</div>
                      \${data.advisorReminders && data.advisorReminders.length > 0 ? 
                          data.advisorReminders.map((reminder, i) => \`<div class="list-item">\${i + 1}. \${reminder}</div>\`).join('') :
                          '<div style="color: #6c757d; font-style: italic; padding: 20px; text-align: center;">No reminders yet</div>'
                      }
                  </div>

                  <div class="dashboard-section">
                      <div class="section-title">⚠️ Client Concerns & Addressing</div>
                      \${data.concerns && data.concerns.length > 0 ? 
                          data.concerns.map((concern, i) => \`
                              <div class="concern-item">
                                  <strong>Concern:</strong> \${concern.concern}<br><br>
                                  <strong>Strategy:</strong> \${concern.addressing_strategy}
                              </div>
                          \`).join('') :
                          '<div style="color: #6c757d; font-style: italic; padding: 20px; text-align: center;">No concerns identified yet</div>'
                      }
                  </div>

                  <div class="dashboard-section">
                      <div class="section-title">❓ Strategic Questions to Ask</div>
                      \${data.strategicQuestions && data.strategicQuestions.length > 0 ? 
                          data.strategicQuestions.map((question, i) => \`
                              <div class="question-item">
                                  <strong>\${i + 1}. Question:</strong> "\${question.question}"<br><br>
                                  <strong>Purpose:</strong> \${question.purpose}
                              </div>
                          \`).join('') :
                          '<div style="color: #6c757d; font-style: italic; padding: 20px; text-align: center;">No strategic questions suggested yet</div>'
                      }
                  </div>
              \`;
          }

          function updateTranscript(transcripts) {
              const container = document.getElementById('transcript-container');
              
              if (!transcripts || transcripts.length === 0) {
                  container.innerHTML = \`
                      <div class="empty-state-transcript">
                          <div class="pulse">🎙️</div>
                          <h3>No transcript data available yet...</h3>
                          <p>Transcription will appear here once the conversation begins.</p>
                      </div>
                  \`;
                  return;
              }
              
              // Group transcripts and format with line breaks
              const transcriptText = transcripts.map(entry => \`
                  <div class="transcript-entry">
                      <div class="transcript-timestamp">[\${entry.timestamp}]</div>
                      <div class="transcript-text">\${entry.text}</div>
                  </div>
              \`).join('');
              
              container.innerHTML = transcriptText;
              
              // Auto-scroll to bottom
              container.scrollTop = container.scrollHeight;
          }

          // Initial load
          updateDashboard();
          
          // Auto-refresh every 2 seconds during active calls, 10 seconds during standby
          function scheduleUpdate() {
              const interval = isActiveCall ? 2000 : 10000;
              setTimeout(() => {
                  updateDashboard().then(scheduleUpdate);
              }, interval);
          }
          scheduleUpdate();

          // Add click event listeners after page loads
          document.addEventListener('DOMContentLoaded', function() {
              // Add click handlers to tabs
              document.querySelector('.tab:first-child').addEventListener('click', function() {
                  showTab('dashboard');
              });
              
              document.querySelector('.tab:last-child').addEventListener('click', function() {
                  showTab('transcript');
              });
          });
      </script>
    </body>
    </html>
  `);
});

// Add API endpoint for transcript data
app.get('/api/transcript', (req, res) => {
  res.json({
    transcripts: global.liveTranscripts || [],
    conversation_id: conversationId,
    timestamp: new Date().toISOString()
  });
});

// Keep the existing API routes
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
    console.log('📡 RTMS Webhook received:', JSON.stringify(req.body, null, 2));
    const { event, payload } = req.body;

    if (event === 'endpoint.url_validation' && payload?.plainToken) {
        const hash = crypto
            .createHmac('sha256', ZOOM_SECRET_TOKEN)
            .update(payload.plainToken)
            .digest('hex');
        console.log('✅ Responding to URL validation challenge');
        return res.json({
            plainToken: payload.plainToken,
            encryptedToken: hash,
        });
    }

    if (event === 'meeting.rtms_started') {
        console.log('\n💼 STARTING FINANCIAL CONSULTATION ANALYSIS');
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
          clientInfo: "Not identified",
          advisorReminders: [],
          concerns: [],
          strategicQuestions: []
        };
        
        console.log(`📞 Meeting ID: ${conversationId}`);
        console.log('🤖 AI Financial Assistant is now monitoring the consultation...\n');
        
        // Initialize audio collection and streaming for this meeting
        initializeAudioCollection(meeting_uuid);
        initializeAssemblyAIStreaming(meeting_uuid);
        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    if (event === 'meeting.rtms_stopped') {
        console.log('\n🏁 CONSULTATION ENDED - GENERATING FINAL REPORT');
        const { meeting_uuid } = payload;
        
        cleanupMeeting(meeting_uuid);
        displayCurrentFinancialData();
    }

    res.sendStatus(200);
});

// Audio Collection Management
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

    console.log(`🔗 Connecting to AssemblyAI streaming for meeting ${meetingUuid}`);

    const streamingWs = new WebSocket(API_ENDPOINT, {
        headers: {
            Authorization: process.env.ASSEMBLYAI_API_KEY,
        },
    });

    collector.streamingWs = streamingWs;

    streamingWs.on('open', () => {
        console.log(`✅ AssemblyAI streaming connected for meeting ${meetingUuid}`);
    });

    streamingWs.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            await handleAssemblyAIMessage(data, meetingUuid);
        } catch (error) {
            console.error(`❌ AssemblyAI message error: ${error}`);
        }
    });

    streamingWs.on('error', (error) => {
        console.error(`❌ AssemblyAI streaming error: ${error}`);
        collector.stopRequested = true;
    });

    streamingWs.on('close', (code, reason) => {
        console.log(`🔌 AssemblyAI streaming closed: ${code} - ${reason}`);
    });
}

async function handleAssemblyAIMessage(data, meetingUuid) {
    const msgType = data.type;

    if (msgType === "Begin") {
        console.log(`🚀 AssemblyAI session started: ${data.id}`);
        // Clear previous transcripts when new session starts
        global.liveTranscripts = [];
    } else if (msgType === "Turn") {
        const transcript = data.transcript || "";
        const formatted = data.turn_is_formatted;

        if (formatted && transcript.trim()) {
            // Final transcript - add to live transcripts
            global.liveTranscripts.push({
                timestamp: new Date().toLocaleTimeString(),
                text: transcript,
                type: 'final'
            });
            
            // Keep only last 50 entries to prevent memory issues
            if (global.liveTranscripts.length > 50) {
                global.liveTranscripts = global.liveTranscripts.slice(-50);
            }
            
            process.stdout.write('\r' + ' '.repeat(100) + '\r');
            console.log(`📝 [${meetingUuid.substring(0, 8)}] FINAL: ${transcript}`);
            
            // Process transcript for financial consultation insights
            await processTranscript(transcript);
            
            // Display updated dashboard
            displayCurrentFinancialData();
        } else if (!formatted && transcript.trim()) {
            // Partial transcript
            process.stdout.write(`\r🎙️  [${meetingUuid.substring(0, 8)}] ${transcript}`);
        }
    } else if (msgType === "Termination") {
        console.log(`\n🏁 AssemblyAI session terminated for ${meetingUuid}`);
        
        // Final consultation summary
        console.log('\n💼 FINAL FINANCIAL CONSULTATION SUMMARY:');
        displayCurrentFinancialData();
    }
}

// Zoom RTMS Functions
function generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET) {
    console.log('🔐 Generating signature for RTMS connection');
    const message = `${CLIENT_ID},${meetingUuid},${streamId}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
}

function connectToSignalingWebSocket(meetingUuid, streamId, serverUrl) {
    console.log(`🔌 Connecting to signaling WebSocket for meeting ${meetingUuid}`);

    const ws = new WebSocket(serverUrl);

    // Store connection for cleanup later
    if (!activeConnections.has(meetingUuid)) {
        activeConnections.set(meetingUuid, {});
    }
    activeConnections.get(meetingUuid).signaling = ws;

    ws.on('open', () => {
        console.log(`✅ Signaling WebSocket connection opened for meeting ${meetingUuid}`);
        const signature = generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET);

        const handshake = {
            msg_type: 1,
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            sequence: Math.floor(Math.random() * 1e9),
            signature,
        };
        ws.send(JSON.stringify(handshake));
        console.log('📤 Sent handshake to signaling server');
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('📨 Signaling Message:', JSON.stringify(msg, null, 2));

        if (msg.msg_type === 2 && msg.status_code === 0) {
            const mediaUrl = msg.media_server?.server_urls?.audio || msg.media_server?.server_urls?.all;
            if (mediaUrl) {
                connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, ws);
            }
        }

        if (msg.msg_type === 12) {
            const keepAliveResponse = {
                msg_type: 13,
                timestamp: msg.timestamp,
            };
            ws.send(JSON.stringify(keepAliveResponse));
        }
    });

    ws.on('error', (err) => {
        console.error('❌ Signaling socket error:', err);
    });

    ws.on('close', () => {
        console.log('🔌 Signaling socket closed');
        if (activeConnections.has(meetingUuid)) {
            delete activeConnections.get(meetingUuid).signaling;
        }
    });
}

function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
    console.log(`🎵 Connecting to media WebSocket at ${mediaUrl}`);

    const mediaWs = new WebSocket(mediaUrl, { rejectUnauthorized: false });

    // Store connection for cleanup later
    if (activeConnections.has(meetingUuid)) {
        activeConnections.get(meetingUuid).media = mediaWs;
    }

    mediaWs.on('open', () => {
        console.log(`✅ Zoom media connected for meeting ${meetingUuid}`);
        const signature = generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET);
        
        const handshake = {
            msg_type: 3,
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature,
            media_type: 1, // Request raw audio
            payload_encryption: false,
        };
        mediaWs.send(JSON.stringify(handshake));
    });

    mediaWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.msg_type === 4 && msg.status_code === 0) {
                signalingSocket.send(JSON.stringify({
                    msg_type: 7,
                    rtms_stream_id: streamId,
                }));
                console.log(`🚀 Started audio streaming for meeting ${meetingUuid}`);
            }

            if (msg.msg_type === 12) {
                mediaWs.send(JSON.stringify({
                    msg_type: 13,
                    timestamp: msg.timestamp,
                }));
            }

            // Handle audio data (msg_type 14 with Base64 data)
            if (msg.msg_type === 14 && msg.content?.data) {
                handleAudioData(msg.content.data, meetingUuid);
            }

        } catch (err) {
            console.log('📦 Received non-JSON data (should not happen with new format)');
        }
    });

    mediaWs.on('error', (err) => {
        console.error('❌ Media socket error:', err);
    });

    mediaWs.on('close', () => {
        console.log('🔌 Media socket closed');
        if (activeConnections.has(meetingUuid)) {
            delete activeConnections.get(meetingUuid).media;
        }
    });
}

function handleAudioData(base64Data, meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector || collector.stopRequested) return;

    // Decode base64 to raw audio buffer
    const audioBuffer = Buffer.from(base64Data, 'base64');
    
    // Store for post-meeting processing
    collector.audioChunks.push(audioBuffer);
    collector.totalBytes += audioBuffer.length;
    collector.chunkCount++;

    // Send to AssemblyAI streaming
    sendToAssemblyAI(audioBuffer, meetingUuid);

    // Log progress every 100 chunks
    if (collector.chunkCount % 100 === 0) {
        const duration = (Date.now() - collector.startTime) / 1000;
        console.log(`🎵 [${meetingUuid.substring(0, 8)}] ${collector.chunkCount} chunks, ${collector.totalBytes} bytes, ${duration.toFixed(1)}s`);
    }
}

function sendToAssemblyAI(audioData, meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector || !collector.streamingWs || collector.stopRequested) return;

    // Add to buffer
    collector.audioBuffer.push(audioData);
    
    // Calculate total buffered size
    const totalBufferedSize = collector.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    
    // Send when we have enough data
    if (totalBufferedSize >= TARGET_CHUNK_SIZE) {
        const combinedBuffer = Buffer.concat(collector.audioBuffer);
        const chunkToSend = combinedBuffer.subarray(0, TARGET_CHUNK_SIZE);
        const remainingData = combinedBuffer.subarray(TARGET_CHUNK_SIZE);
        
        collector.audioBuffer = remainingData.length > 0 ? [remainingData] : [];
        
        if (collector.streamingWs.readyState === WebSocket.OPEN) {
            try {
                collector.streamingWs.send(chunkToSend);
            } catch (error) {
                console.error(`❌ Error sending to AssemblyAI: ${error}`);
            }
        }
    }
}

function flushAudioBuffer(meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector || collector.audioBuffer.length === 0) return;

    const combinedBuffer = Buffer.concat(collector.audioBuffer);
    const minChunkSize = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 50) / 1000; // 50ms minimum
    
    if (combinedBuffer.length >= minChunkSize && collector.streamingWs?.readyState === WebSocket.OPEN) {
        try {
            collector.streamingWs.send(combinedBuffer);
            console.log(`🔄 Flushed remaining audio for meeting ${meetingUuid}`);
        } catch (error) {
            console.error(`❌ Error flushing audio: ${error}`);
        }
    }
    
    collector.audioBuffer = [];
}

async function cleanupMeeting(meetingUuid) {
    const collector = audioCollectors.get(meetingUuid);
    if (!collector) return;

    console.log(`🧹 Cleaning up meeting ${meetingUuid}`);
    
    // Stop streaming
    collector.stopRequested = true;
    
    // Flush remaining audio
    flushAudioBuffer(meetingUuid);
    
    // Close AssemblyAI connection
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
            console.error(`❌ Error closing AssemblyAI: ${error}`);
        }
    }

    // Close Zoom connections
    if (activeConnections.has(meetingUuid)) {
        const connections = activeConnections.get(meetingUuid);
        for (const conn of Object.values(connections)) {
            if (conn && typeof conn.close === 'function') {
                conn.close();
            }
        }
        activeConnections.delete(meetingUuid);
    }

    // Optional: Save audio file for backup/analysis
    if (collector.audioChunks.length > 0) {
        await processRecordedAudio(meetingUuid, collector.audioChunks);
    }

    // Cleanup collector
    audioCollectors.delete(meetingUuid);
}

// AI Analysis Functions
function getSystemPrompt(callContext) {
  return `You are an expert financial consultation analyst monitoring an ongoing financial advisory conversation in real-time. 
    Your role is to provide valuable insights to the financial advisor by analyzing the consultation as it unfolds. 
    Only make updates that help the advisor better serve their client. The insights you are providing should be regarding the client.

    The conversation may or may not be labeled with speakers (Advisor: or Client:) to help you understand who is speaking.
    If the conversations is not labeled, do your best to infer who is speaking.
    You should focus on identifying key information about the client's financial situation, goals, concerns, and opportunities while 
    maintaining an organized understanding of the consultation's progress.
    
    Pay special attention to:
    - Financial capacity and assets (Funds)
    - Decision-making authority (Authority) 
    - Level of engagement and investment appetite (Interest)
    - Financial goals and problems to solve (Need)
    - Timeline for financial decisions (Timing)
    - Client concerns, fears, or hesitations about financial products/decisions
    - Opportunities for the advisor to provide value
    - Information gaps where strategic questions could help gather more useful data
    
    ${callContext ? `\nAdditional context for this specific consultation: ${callContext}` : ''}`;
}

async function executeToolAndGetResult(toolUse) {
  switch (toolUse.name) {
    case 'update_summary':
      financialData.summary.push(toolUse.input.new_point);
      logFinancialUpdate('CONSULTATION SUMMARY UPDATE', toolUse.input.new_point);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Summary point added successfully"
      };
    case 'update_faint':
      financialData.faint = { ...financialData.faint, ...toolUse.input };
      logFinancialUpdate('FAINT QUALIFICATION UPDATE', toolUse.input);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "FAINT information updated successfully"
      };
    case 'update_client_info':
      financialData.clientInfo = toolUse.input.clientInfo;
      logFinancialUpdate('CLIENT INFO UPDATE', toolUse.input.clientInfo);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Client information updated successfully"
      };
    case 'update_advisor_reminders':
      financialData.advisorReminders.push(toolUse.input.new_reminder);
      logFinancialUpdate('ADVISOR REMINDER', toolUse.input.new_reminder);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Advisor reminder added successfully"
      };
    case 'update_concerns':
      financialData.concerns.push(toolUse.input.new_concern);
      logFinancialUpdate('CLIENT CONCERN IDENTIFIED', toolUse.input.new_concern);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "New concern added successfully"
      };
    case 'update_strategic_questions':
      financialData.strategicQuestions.push(toolUse.input.new_question);
      logFinancialUpdate('STRATEGIC QUESTION SUGGESTED', toolUse.input.new_question);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Strategic question added successfully"
      };
    default:
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Tool execution completed"
      };
  }
}

function logFinancialUpdate(type, data) {
  console.log('\n' + '='.repeat(60));
  console.log(`💰 ${type} - ${new Date().toLocaleTimeString()}`);
  console.log('='.repeat(60));
  
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
  
  console.log('='.repeat(60) + '\n');
}

function displayCurrentFinancialData() {
  console.log('\n' + '█'.repeat(80));
  console.log('💼 FINANCIAL CONSULTATION INTELLIGENCE DASHBOARD');
  console.log('█'.repeat(80));
  
  console.log('\n📝 CONSULTATION SUMMARY:');
  if (financialData.summary.length > 0) {
    financialData.summary.forEach((point, index) => {
      console.log(`  ${index + 1}. ${point}`);
    });
  } else {
    console.log('  No key points identified yet');
  }
  
  console.log('\n💎 FAINT QUALIFICATION:');
  console.log(`  Funds:     ${financialData.faint.funds}`);
  console.log(`  Authority: ${financialData.faint.authority}`);
  console.log(`  Interest:  ${financialData.faint.interest}`);
  console.log(`  Need:      ${financialData.faint.need}`);
  console.log(`  Timing:    ${financialData.faint.timing}`);
  
  console.log('\n👤 CLIENT INFO:');
  console.log(`  ${financialData.clientInfo}`);
  
  console.log('\n💡 ADVISOR REMINDERS:');
  if (financialData.advisorReminders.length > 0) {
    financialData.advisorReminders.forEach((reminder, index) => {
      console.log(`  ${index + 1}. ${reminder}`);
    });
  } else {
    console.log('  No reminders yet');
  }
  
  console.log('\n⚠️  CLIENT CONCERNS & ADDRESSING:');
  if (financialData.concerns.length > 0) {
    financialData.concerns.forEach((concern, index) => {
      console.log(`  ${index + 1}. Concern: ${concern.concern}`);
      console.log(`     Strategy: ${concern.addressing_strategy}`);
    });
  } else {
    console.log('  No concerns identified yet');
  }
  
  console.log('\n❓ STRATEGIC QUESTIONS TO ASK:');
  if (financialData.strategicQuestions.length > 0) {
    financialData.strategicQuestions.forEach((question, index) => {
      console.log(`  ${index + 1}. Question: "${question.question}"`);
      console.log(`     Purpose: ${question.purpose}`);
    });
  } else {
    console.log('  No strategic questions suggested yet');
  }
  
  console.log('\n' + '█'.repeat(80) + '\n');
}

async function processTranscript(transcript) {
  if (!transcript.trim()) return;
  
  console.log('\n🔍 Processing transcript for financial consultation insights...');
  console.log(`Transcript: "${transcript}"`);
  
  try {
    const userMessage = {
      role: "user",
      content: `New consultation segment: ${transcript}`
    };
    conversationHistory.push(userMessage);

    // Filter out empty messages
    const validHistory = conversationHistory.filter(msg => {
      if (Array.isArray(msg.content)) {
        return msg.content.length > 0;
      }
      return msg.content && msg.content.trim().length > 0;
    });

    let message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages: validHistory
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

      // Get next message
      const validHistoryAfterTools = conversationHistory.filter(msg => {
        if (Array.isArray(msg.content)) {
          return msg.content.length > 0;
        }
        return msg.content && msg.content.trim().length > 0;
      });

      message = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: getSystemPrompt(),
        tools: TOOLS,
        messages: validHistoryAfterTools
      });
    }

    if (message.stop_reason !== 'tool_use' && message.content && message.content.length > 0) {
      conversationHistory.push({
        role: "assistant",
        content: message.content
      });
    }

    // Save consultation logs
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

  } catch (error) {
    console.error('❌ Error processing transcript:', error);
  }
}

async function processRecordedAudio(meetingId, audioChunks) {
  if (audioChunks.length === 0) {
    console.log("❌ No audio data received");
    return;
  }

  const rawFilename = `recording_${meetingId}.raw`;
  const wavFilename = `recording_${meetingId}.wav`;

  try {
    const combinedBuffer = Buffer.concat(audioChunks);
    fs.writeFileSync(rawFilename, combinedBuffer);

    await convertRawToWav(rawFilename, wavFilename);
    console.log("🎵 WAV saved: ", wavFilename);

    console.log("📄 Starting post-consultation transcription for backup...");
    
    const client = new AssemblyAI({
      apiKey: process.env.ASSEMBLYAI_API_KEY,
    });
    
    const transcript = await client.transcripts.transcribe({
      audio: wavFilename,
    });

    if (transcript.status === "error") {
      console.error(`❌ Post-consultation transcription failed: ${transcript.error}`);
    } else {
      console.log("✅ Post-consultation transcription completed");
      
      // Save final report
      const finalReport = {
        meetingId,
        timestamp: new Date().toISOString(),
        financialData,
        conversationHistory,
        fullTranscript: transcript.text
      };
      
      fs.writeFileSync(
        `./consultation_logs/${meetingId}_final_report.json`, 
        JSON.stringify(finalReport, null, 2)
      );
      
      console.log(`📊 Final consultation report saved: ./consultation_logs/${meetingId}_final_report.json`);
    }
  } catch (error) {
    console.error("❌ Post-consultation transcription error:", error);
  } finally {
    // Cleanup
    try {
      if (fs.existsSync(rawFilename)) fs.unlinkSync(rawFilename);
      if (fs.existsSync(wavFilename)) fs.unlinkSync(wavFilename);
    } catch (e) {
      console.error("❌ Error cleaning up audio files:", e);
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
  console.log(`🔗 Webhook endpoint at http://localhost:${PORT}/webhook`);
  console.log('💡 Make sure your environment variables are set in .env\n');
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Ctrl+C received. Stopping...");
  
  // Clean up all active meetings
  for (const [meetingId] of audioCollectors.entries()) {
    cleanupMeeting(meetingId);
  }
  
  setTimeout(() => process.exit(0), 2000);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Termination signal received. Stopping...");
  
  // Clean up all active meetings
  for (const [meetingId] of audioCollectors.entries()) {
    cleanupMeeting(meetingId);
  }
  
  setTimeout(() => process.exit(0), 2000);
});

process.on("uncaughtException", (error) => {
  console.error(`\n❌ Uncaught exception: ${error}`);
  setTimeout(() => process.exit(1), 1000);
});

console.log('\n💼 ZOOM FINANCIAL CONSULTATION INTELLIGENCE SYSTEM STARTED');
console.log('🤖 Ready to analyze financial consultations...');