import rtms from "@zoom/rtms";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import WebSocket from "ws";
import querystring from "querystring";
import { AssemblyAI } from "assemblyai";
import Anthropic from "@anthropic-ai/sdk";

const execAsync = promisify(exec);
let audioChunks = [];
let rtmsClient = null;
let streamingWs = null;
let stopRequested = false;

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

// Audio buffering for streaming
let audioBuffer = [];
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const TARGET_CHUNK_DURATION_MS = 100;
const TARGET_CHUNK_SIZE = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * TARGET_CHUNK_DURATION_MS) / 1000;

// New v3 Streaming Configuration
const CONNECTION_PARAMS = {
  sample_rate: SAMPLE_RATE,
  format_turns: true,
};
const API_ENDPOINT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";
const API_ENDPOINT = `${API_ENDPOINT_BASE_URL}?${querystring.stringify(CONNECTION_PARAMS)}`;

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

function initializeStreamingTranscription() {
  if (streamingWs) {
    streamingWs.close();
  }

  audioBuffer = [];

  streamingWs = new WebSocket(API_ENDPOINT, {
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY,
    },
  });

  streamingWs.on("open", () => {
    console.log("🎙️  Streaming WebSocket connection opened.");
    console.log(`Connected to: ${API_ENDPOINT}`);
    console.log(`Target chunk size: ${TARGET_CHUNK_SIZE} bytes (${TARGET_CHUNK_DURATION_MS}ms)`);
  });

  streamingWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      const msgType = data.type;

      if (msgType === "Begin") {
        const sessionId = data.id;
        const expiresAt = data.expires_at;
        console.log(
          `✅ Session began: ID=${sessionId}, ExpiresAt=${new Date(expiresAt * 1000).toISOString()}`
        );
      } else if (msgType === "Turn") {
        const transcript = data.transcript || "";
        const formatted = data.turn_is_formatted;

        if (formatted) {
          // Clear line and print final transcript
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
          console.log("📝 Real-time Final:", transcript);
          
          // Process transcript for financial consultation insights
          await processTranscript(transcript);
          
          // Display updated dashboard every few transcripts
          displayCurrentFinancialData();
        } else {
          // Show partial transcript
          process.stdout.write(`\r📝 Real-time Partial: ${transcript}`);
        }
      } else if (msgType === "Termination") {
        const audioDuration = data.audio_duration_seconds;
        const sessionDuration = data.session_duration_seconds;
        console.log(
          `\n🏁 Session Terminated: Audio Duration=${audioDuration}s, Session Duration=${sessionDuration}s`
        );
        
        // Final consultation summary
        console.log('\n💼 FINAL FINANCIAL CONSULTATION SUMMARY:');
        displayCurrentFinancialData();
      }
    } catch (error) {
      console.error(`❌ Error handling streaming message: ${error}`);
    }
  });

  streamingWs.on("error", (error) => {
    console.error(`❌ Streaming WebSocket Error: ${error}`);
    stopRequested = true;
  });

  streamingWs.on("close", (code, reason) => {
    console.log(`🔌 Streaming WebSocket Disconnected: Status=${code}, Msg=${reason}`);
  });
}

function sendBufferedAudio(data) {
  audioBuffer.push(data);
  
  const totalBufferedSize = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
  
  if (totalBufferedSize >= TARGET_CHUNK_SIZE) {
    const combinedBuffer = Buffer.concat(audioBuffer);
    const chunkToSend = combinedBuffer.subarray(0, TARGET_CHUNK_SIZE);
    const remainingData = combinedBuffer.subarray(TARGET_CHUNK_SIZE);
    audioBuffer = remainingData.length > 0 ? [remainingData] : [];
    
    if (streamingWs && streamingWs.readyState === WebSocket.OPEN && !stopRequested) {
      try {
        streamingWs.send(chunkToSend);
      } catch (error) {
        console.error("❌ Error sending audio to streaming transcription:", error);
      }
    }
  }
}

function flushAudioBuffer() {
  if (audioBuffer.length > 0) {
    const combinedBuffer = Buffer.concat(audioBuffer);
    const minChunkSize = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 50) / 1000;
    
    if (combinedBuffer.length >= minChunkSize && streamingWs && streamingWs.readyState === WebSocket.OPEN) {
      try {
        streamingWs.send(combinedBuffer);
        console.log(`🔄 Flushed remaining ${combinedBuffer.length} bytes to streaming API`);
      } catch (error) {
        console.error("❌ Error flushing audio buffer:", error);
      }
    }
    
    audioBuffer = [];
  }
}

function cleanupStreamingTranscription() {
  stopRequested = true;
  flushAudioBuffer();
  
  if (streamingWs && [WebSocket.OPEN, WebSocket.CONNECTING].includes(streamingWs.readyState)) {
    try {
      if (streamingWs.readyState === WebSocket.OPEN) {
        const terminateMessage = { type: "Terminate" };
        console.log(`📤 Sending termination message: ${JSON.stringify(terminateMessage)}`);
        streamingWs.send(JSON.stringify(terminateMessage));
      }
      
      setTimeout(() => {
        if (streamingWs) {
          streamingWs.close();
          streamingWs = null;
        }
      }, 1000);
    } catch (error) {
      console.error(`❌ Error closing streaming WebSocket: ${error}`);
    }
  }
  
  audioBuffer = [];
}

rtms.onWebhookEvent(({ event, payload }) => {
  console.log('📡', event, payload);

  if (event === "meeting.rtms_started") {
    // Initialize consultation
    conversationId = payload.meeting_uuid.replace(/[^a-zA-Z0-9]/g, "_");
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
    
    console.log('\n💼 STARTING FINANCIAL CONSULTATION ANALYSIS');
    console.log(`📞 Meeting ID: ${conversationId}`);
    console.log('🤖 AI Financial Assistant is now monitoring the consultation...\n');
    
    initializeStreamingTranscription();
    
    rtmsClient = new rtms.Client();

    rtmsClient.onAudioData((data, timestamp, metadata) => {
      audioChunks.push(data);
      sendBufferedAudio(data);
    });

    rtmsClient.join(payload);
  } else if (event === "meeting.rtms_stopped") {
    cleanupStreamingTranscription();
    
    console.log('\n🏁 CONSULTATION ENDED - GENERATING FINAL REPORT');
    displayCurrentFinancialData();
    
    if (audioChunks.length === 0) {
      console.error("❌ No audio data received");
      process.exit(1);
    }

    const meetingId = payload.meeting_uuid.replace(/[^a-zA-Z0-9]/g, "_");
    const rawFilename = `recording_${meetingId}.raw`;
    const wavFilename = `recording_${meetingId}.wav`;

    const combinedBuffer = Buffer.concat(audioChunks);
    fs.writeFileSync(rawFilename, combinedBuffer);

    convertRawToWav(rawFilename, wavFilename)
      .then(async () => {
        console.log("🎵 WAV saved: ", wavFilename);

        try {
          console.log("📄 Starting post-consultation transcription for backup...");
          
          const { AssemblyAI } = await import("assemblyai");
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
          audioChunks = [];
          if (rtmsClient) {
            rtmsClient.leave();
            rtmsClient = null;
          }
          fs.unlinkSync(wavFilename);
        }
      })
      .catch((error) => {
        console.error("❌ Error converting audio:", error);
        audioChunks = [];
        if (rtmsClient) {
          rtmsClient.leave();
          rtmsClient = null;
        }
      });
  }
});

async function convertRawToWav(rawFilename, wavFilename) {
  const command = `ffmpeg -y -f s16le -ar 16000 -ac 1 -i ${rawFilename} ${wavFilename}`;
  await execAsync(command);
  fs.unlinkSync(rawFilename);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Ctrl+C received. Stopping...");
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Termination signal received. Stopping...");
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on("uncaughtException", (error) => {
  console.error(`\n❌ Uncaught exception: ${error}`);
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(1), 1000);
});

console.log('\n💼 ZOOM FINANCIAL CONSULTATION INTELLIGENCE SYSTEM STARTED');
console.log('🤖 Ready to analyze financial consultations...');
console.log('💡 Make sure your ASSEMBLYAI_API_KEY and ANTHROPIC_API_KEY are set in .env\n');