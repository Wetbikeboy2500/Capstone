import { setTimeout } from 'timers';
import { EmailContent, newRequestMessage, RequestMessage, ResponseMessage, SYSTEM_PROMPT } from './types';

// Define type for port connection
let port: chrome.runtime.Port | null = null;
let messageHandlers = new Map<string, (response: ResponseMessage) => void>();
let isProcessingQueue = false;
let messageQueue: {email: EmailContent, handler: (response: ResponseMessage) => void}[] = [];

function connectToServiceWorker() {
  if (port) return; // Already connected
  
  port = chrome.runtime.connect({ name: "web_llm_service_worker" });
  
  port.onMessage.addListener((message: ResponseMessage) => {
    if (message.responseType === 'completion') {
      console.log('Received completion from service worker:', message);
      const handler = messageHandlers.get(message.requestId);
      if (handler) {
        handler(message);
        messageHandlers.delete(message.requestId);
        
        // Mark queue as not processing before handling next item
        isProcessingQueue = false;
        // Process next item in queue if available
        setTimeout(processNextQueueItem, 0);
      }
    } else if (message.responseType === 'error') {
      console.error('Error from service worker:', message);
      const handler = messageHandlers.get(message.requestId);
      if (handler) {
        handler(message);
        messageHandlers.delete(message.requestId);
        
        // Mark queue as not processing before handling next item
        isProcessingQueue = false;
        // Process next item in queue if available
        setTimeout(processNextQueueItem, 0);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    isProcessingQueue = false; // Reset processing flag on disconnect
    
    const attemptReconnect = () => {
      console.log('Disconnected from service worker, attempting to reconnect...');
      connectToServiceWorker();
      
      if (!port) {
        setTimeout(attemptReconnect, 1000);
      } else {
        console.log('Successfully reconnected to service worker');
        setTimeout(processNextQueueItem, 0);
      }
    };
    
    // Start reconnection process
    attemptReconnect();
  });
}

// Initial connection
connectToServiceWorker();

function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function createPromptFromEmail(email: EmailContent): string {
  // Gemma requires a combined prompt with system and user instructions together
  return `${SYSTEM_PROMPT}

Now analyze the security profile of this email:
Subject: ${email.subject}
From: ${email.sender}
Body: ${email.body}
URLs: ${email.urls.join(', ')}`;
}

function processNextQueueItem() {
  if (messageQueue.length === 0 || isProcessingQueue) {
    return;
  }
  
  isProcessingQueue = true;
  const { email, handler } = messageQueue.shift()!;
  
  try {
    if (!port) {
      connectToServiceWorker();
      if (!port) {
        handler({
          responseType: 'error',
          requestId: 'connection-failed',
          brief_analysis: 'Could not connect to service worker',
          type: 'unknown_threat',
          confidence: 0
        });
        isProcessingQueue = false;
        return;
      }
    }
    
    const requestId = generateRequestId();
    messageHandlers.set(requestId, handler);
    
    const prompt = createPromptFromEmail(email);
    
    const message: RequestMessage = newRequestMessage({
      requestType: 'request',
      prompt: prompt,
      requestId: requestId
    });
    
    console.log('Sending request to service worker:', message);
    port.postMessage(message);
  } catch (error) {
    console.error('Error processing email:', error);
    handler({
      responseType: 'error',
      requestId: 'processing-error',
      brief_analysis: error instanceof Error ? error.message : 'Unknown error occurred',
      type: 'unknown_threat',
      confidence: 0
    });
    isProcessingQueue = false;
    
    // Try next item
    setTimeout(processNextQueueItem, 0);
  }
}

export function sendEmailContent(email: EmailContent, handler: (response: ResponseMessage) => void): void {
  // Add to queue
  messageQueue.push({email, handler});
  
  // Try to process immediately if not already processing
  if (!isProcessingQueue) {
    processNextQueueItem();
  }
}

export function clearMessageHandlers(): void {
  messageHandlers.clear();
  messageQueue = [];
  isProcessingQueue = false;
  
  if (port) {
    port.disconnect();
    port = null;
  }
}