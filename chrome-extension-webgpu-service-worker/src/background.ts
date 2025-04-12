import { newResponseMessage, RequestMessage } from './types';

// State management
let isProcessing = false;
let requestsQueue: { message: RequestMessage, port: chrome.runtime.Port }[] = [];
let hasInsufficientResources = false;
let requiredRAMMB: number | null = null;
let availableRAMMB: number | null = null;

// Offscreen document configuration
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let isOffscreenDocumentReady = false;
let isModelLoaded = false;
let offscreenDocumentCreating = false;

let cleanupTimer: NodeJS.Timeout | null = null;
const CLEANUP_DELAY = 60000; // 1 minute

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

async function cleanupOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    console.log('ServiceWorker: Cleaning up offscreen document due to inactivity');
    await chrome.offscreen.closeDocument();
    isOffscreenDocumentReady = false;
    isModelLoaded = false;
  }
}

// Process requests from queue
function processQueue() {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }

  if (requestsQueue.length === 0) {
    cleanupTimer = setTimeout(cleanupOffscreenDocument, CLEANUP_DELAY);
    return;
  }
  
  if (isProcessing) {
    return;
  }
  
  const nextRequest = requestsQueue.shift();
  if (nextRequest) {
    isProcessing = true;
    processRequest(nextRequest.message, nextRequest.port)
      .finally(() => {
        isProcessing = false;
        // Try to process more requests
        setTimeout(processQueue, 0);
      });
  }
}

// Process a single request
async function processRequest(message: RequestMessage, port: chrome.runtime.Port): Promise<void> {
  try {
    console.log('ServiceWorker: Processing request', message.requestId);
    
    // If we already know we have insufficient resources, immediately return error
    if (hasInsufficientResources) {
      sendInsufficientResourcesError(port, message.requestId);
      return;
    }

    // Ensure offscreen document is created
    if (!isOffscreenDocumentReady) {
      await createOffscreenDocument();
    }
    
    // Wait for model to be loaded or insufficient resources signal
    if (!isModelLoaded && !hasInsufficientResources) {
      console.log('ServiceWorker: Waiting for model to load');
      await new Promise(resolve => {
        const checkModelLoaded = setInterval(() => {
          if (isModelLoaded || hasInsufficientResources) {
            clearInterval(checkModelLoaded);
            resolve(null);
          }
        }, 100);
      });
    }

    // Check again after waiting in case status changed
    if (hasInsufficientResources) {
      sendInsufficientResourcesError(port, message.requestId);
      return;
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

function sendInsufficientResourcesError(port: chrome.runtime.Port, requestId: string) {
  const memoryMessage = requiredRAMMB && availableRAMMB
    ? `Required: ${requiredRAMMB}MB, Available: ${availableRAMMB}MB`
    : 'Insufficient system memory';
    
  port.postMessage({
    responseType: 'error',
    error: `Insufficient system resources to run the model. ${memoryMessage}`,
    requestId: requestId,
    brief_analysis: 'Cannot process request due to insufficient system resources',
    type: 'unknown_threat',
    confidence: 0
  });
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

// Listen for messages from offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'modelLoaded') {
    isModelLoaded = true;
    hasInsufficientResources = false;
    console.log('ServiceWorker: Model loaded');
    // Try processing queue now that model is ready
    processQueue();
    sendResponse({received: true});
    return true;
  }

  if (message.type === 'insufficientResources') {
    console.error('ServiceWorker: Insufficient resources:', message);
    hasInsufficientResources = true;
    requiredRAMMB = message.requiredRAMMB;
    availableRAMMB = message.availableRAMMB;
    isModelLoaded = false;
    processQueue(); // Process queue to send error responses
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
  
  // Handle system info request from offscreen document
  if (message.type === 'getSystemInfo') {
    console.log('ServiceWorker: Getting system info for offscreen document');
    
    // Create a Promise to handle the async APIs
    const getSystemInfoPromise = new Promise((resolve) => {
      chrome.system.memory.getInfo((memoryInfo) => {
        chrome.system.cpu.getInfo((cpuInfo) => {
          resolve({
            availableRAMMB: Math.floor(memoryInfo.availableCapacity / (1024 * 1024)),
            totalRAMMB: Math.floor(memoryInfo.capacity / (1024 * 1024)),
            cpuThreads: cpuInfo.numOfProcessors,
            hardwareConcurrency: navigator.hardwareConcurrency || cpuInfo.numOfProcessors
          });
        });
      });
    });
    
    // Return the system info
    getSystemInfoPromise.then((systemInfo) => {
      sendResponse(systemInfo);
    });
    
    return true; // Indicate we'll respond asynchronously
  }
  
  return false;
});

// Set up port connection listener
chrome.runtime.onConnect.addListener(function (port: chrome.runtime.Port): void {
  console.log('ServiceWorker: New port connection');
  console.assert(port.name === "web_llm_service_worker");
  
  // Listen for messages
  port.onMessage.addListener((message: RequestMessage) => {
    requestsQueue.push({ message, port });
    processQueue();
  });
});