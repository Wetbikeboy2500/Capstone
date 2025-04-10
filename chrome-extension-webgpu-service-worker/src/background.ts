import { newResponseMessage, RequestMessage } from './types';

// Queue management
const MAX_CONCURRENT_REQUESTS = 3;
let activeRequestsCount = 0;
let requestsQueue: { message: RequestMessage, port: chrome.runtime.Port }[] = [];

// Offscreen document configuration
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let isOffscreenDocumentReady = false;
let isModelLoaded = false;
let modelContextSize: number | null = null;
let offscreenDocumentCreating = false;

/**
 * Checks if an offscreen document already exists
 */
async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl]
  });

  return existingContexts.length > 0;
}

/**
 * Creates the offscreen document for running wllama
 */
async function createOffscreenDocument() {
  if (offscreenDocumentCreating) return;
  
  offscreenDocumentCreating = true;
  
  try {
    // Check if we already have an offscreen document
    const offscreenExists = await hasOffscreenDocument();
    if (offscreenExists) {
      console.log('ServiceWorker: Offscreen document already exists');
      isOffscreenDocumentReady = true;
      offscreenDocumentCreating = false;
      return;
    }
    
    console.log('ServiceWorker: Creating offscreen document');
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
      reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
      justification: 'Running wllama model inference which breaks files into blobs and runs on multiple workers'
    });
    
    isOffscreenDocumentReady = true;
    console.log('ServiceWorker: Offscreen document created');
    
    // Initialize the model
    chrome.runtime.sendMessage({type: 'initialize'});
  } catch (error) {
    console.error('ServiceWorker: Failed to create offscreen document:', error);
    offscreenDocumentCreating = false;
    throw error;
  }
  
  offscreenDocumentCreating = false;
}

// Process requests from queue
function processQueue() {
  if (requestsQueue.length === 0 || activeRequestsCount >= MAX_CONCURRENT_REQUESTS) {
    return;
  }
  
  while (activeRequestsCount < MAX_CONCURRENT_REQUESTS && requestsQueue.length > 0) {
    const nextRequest = requestsQueue.shift();
    if (nextRequest) {
      activeRequestsCount++;
      processRequest(nextRequest.message, nextRequest.port)
        .finally(() => {
          activeRequestsCount--;
          // Try to process more requests
          setTimeout(processQueue, 0);
        });
    }
  }
}

// Process a single request
async function processRequest(message: RequestMessage, port: chrome.runtime.Port): Promise<void> {
  try {
    console.log('ServiceWorker: Processing request', message.requestId);
    
    // Ensure offscreen document is created
    if (!isOffscreenDocumentReady) {
      await createOffscreenDocument();
    }
    
    // Wait for model to be loaded
    if (!isModelLoaded) {
      console.log('ServiceWorker: Waiting for model to load');
      await new Promise(resolve => {
        const checkModelLoaded = setInterval(() => {
          if (isModelLoaded) {
            clearInterval(checkModelLoaded);
            resolve(null);
          }
        }, 100);
      });
    }
    
    // Send the inference request to the offscreen document
    const response = await chrome.runtime.sendMessage({
      type: 'inference',
      request: message
    });
    
    if (!response.success) {
      throw new Error(response.error || "Unknown error during inference");
    }
    
    // Send results back to the client
    port.postMessage(newResponseMessage({
      responseType: 'completion',
      requestId: message.requestId,
      ...response.result,
    }));
  } catch (error: unknown) {
    sendErrorResponse(port, message.requestId, error);
  }
}

function sendErrorResponse(port: chrome.runtime.Port, requestId: string, error: unknown) {
  console.error('ServiceWorker: Error processing message', error);
  port.postMessage({
    responseType: 'error',
    error: error instanceof Error ? error.toString() : 'Unknown error occurred',
    requestId: requestId,
    brief_analysis: error instanceof Error ? error.message : 'Unknown error occurred',
    type: 'unknown_threat',
    confidence: 0
  });
}

// Create message handler for processing requests
async function handleMessage(message: RequestMessage, port: chrome.runtime.Port): Promise<void> {
  console.log('ServiceWorker: Received message', message);
  
  // Add to queue
  requestsQueue.push({ message, port });
  
  // Try to process the queue
  processQueue();
}

// Listen for messages from offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'modelLoaded') {
    isModelLoaded = true;
    modelContextSize = message.contextSize;
    console.log('ServiceWorker: Model loaded with context size', modelContextSize);
    // Try processing queue now that model is ready
    processQueue();
    sendResponse({received: true});
    return true;
  }
  
  if (message.type === 'modelLoadError') {
    console.error('ServiceWorker: Model load error:', message.error);
    isModelLoaded = false;
    sendResponse({received: true});
    return true;
  }
  
  if (message.type === 'modelLoadProgress') {
    console.log(`ServiceWorker: Model loading ${message.progressPercentage}%`);
    // Could broadcast progress to interested clients
    sendResponse({received: true});
    return true;
  }
  
  return false;
});

// Set up port connection listener
chrome.runtime.onConnect.addListener(function (port: chrome.runtime.Port): void {
  console.log('ServiceWorker: New port connection');
  console.assert(port.name === "web_llm_service_worker");
  
  // Listen for messages
  port.onMessage.addListener((message: RequestMessage) => handleMessage(message, port));
});

// Initialize offscreen document when service worker starts
createOffscreenDocument();